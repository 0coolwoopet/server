/**
 * An R2-shaped bucket that keeps its objects in a GitHub repository, for deployments with no
 * R2 (R2 needs a payment method on the Cloudflare account).
 *
 * It implements only the slice of the R2 API this codebase calls — `get` (with `range` and
 * `onlyIf.etagDoesNotMatch`), `head`, `put` and `delete` — so the workers keep working against
 * the `R2Bucket` type unchanged. It switches on when the `GITHUB_STORAGE_REPO` var is set; with
 * it unset, `withGithubStorage` does nothing and the real R2 bindings are used.
 *
 * Layout: one repo, one folder per bucket (`cdn/` for CDN_ASSETS, `img/` for IMAGES), object key
 * = file path. An object that was stored with a content type or SHA-256 also gets a small
 * `<key>.__meta.json` file beside it, because git has nowhere else to keep that.
 *
 * Reads stream from raw.githubusercontent.com (no API rate limit, honours `Range`); writes,
 * deletes and `head` use the Contents API. Know the limits before leaning on this: the API
 * allows about 5000 requests an hour per token and rate-limits rapid content creation, each
 * upload is a commit, files over ~100 MB cannot be stored, and an overwritten file can be
 * served stale by the raw host for a few minutes. Fine for a small private server; not a CDN.
 */
import type { MiddlewareHandler } from 'hono'

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'
const META_SUFFIX = '.__meta.json'
const MAX_ATTEMPTS = 6

type TokenSource = string | { get(): Promise<string> } | undefined

interface GithubEnv {
	GITHUB_STORAGE_REPO?: string
	GITHUB_STORAGE_BRANCH?: string
	GITHUB_STORAGE_TOKEN?: TokenSource
}

interface Meta {
	contentType?: string
	sha256?: string
	custom?: Record<string, string>
}

interface Info extends Meta {
	size: number
	etag: string
	uploaded: Date
}

const IMAGE_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp'
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function toBase64(bytes: Uint8Array): string {
	const NodeBuffer = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(e: string): string } } })
		.Buffer
	if (NodeBuffer) return NodeBuffer.from(bytes).toString('base64')
	let binary = ''
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	}
	return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text.replace(/\s/g, ''))
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
	return out
}

const toHex = (buffer: ArrayBuffer) =>
	[...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')

function fromHex(hex: string): ArrayBuffer {
	const out = new Uint8Array(hex.length / 2)
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
	return out.buffer
}

const cleanEtag = (value: string) => value.replace(/^W\//, '').replace(/"/g, '')

async function toBytes(value: unknown): Promise<Uint8Array> {
	if (value === null || value === undefined) return new Uint8Array()
	if (typeof value === 'string') return new TextEncoder().encode(value)
	if (value instanceof ArrayBuffer) return new Uint8Array(value)
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
	}
	if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
	return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer())
}

/** Resolve a request's range option to a `bytes=` header value, or null for "whole object". */
function rangeHeader(range: unknown): string | null {
	if (!range) return null
	let value: string | null = null
	if (range instanceof Headers) value = range.get('range')
	else if (typeof (range as Headers).get === 'function') value = (range as Headers).get('range')
	else {
		const r = range as { offset?: number; length?: number; suffix?: number }
		if (r.suffix !== undefined) value = `bytes=-${r.suffix}`
		else if (r.offset !== undefined) {
			value = `bytes=${r.offset}-${r.length !== undefined ? r.offset + r.length - 1 : ''}`
		} else if (r.length !== undefined) value = `bytes=0-${r.length - 1}`
	}
	// Like R2, anything that isn't a single `bytes=` range means the whole object.
	if (!value || !value.startsWith('bytes=') || value.includes(',')) return null
	return value
}

/** Resolve `bytes=a-b` / `a-` / `-n` against a known size; null when unsatisfiable. */
function resolveRange(header: string, size: number): { offset: number; length: number } | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header)
	if (!match) return null
	const [, from, to] = match
	if (from === '' && to === '') return null
	if (from === '') {
		const length = Math.min(Number(to), size)
		return length > 0 ? { offset: size - length, length } : null
	}
	const offset = Number(from)
	if (offset >= size) return null
	const end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
	return end >= offset ? { offset, length: end - offset + 1 } : null
}

class GithubBucket {
	constructor(
		private readonly repo: string,
		private readonly branch: string,
		private readonly prefix: string,
		private readonly tokenSource: TokenSource
	) {}

	private async token(): Promise<string> {
		const source = this.tokenSource
		const token = typeof source === 'string' ? source : await source?.get()
		if (!token) throw new Error('GITHUB_STORAGE_TOKEN is not configured')
		return token
	}

	private path(key: string): string {
		const segments = key.split('/')
		if (key === '' || segments.some((s) => s === '' || s === '.' || s === '..')) {
			throw new Error(`invalid storage key: ${key}`)
		}
		return this.prefix + key
	}

	private encoded(path: string): string {
		return path.split('/').map(encodeURIComponent).join('/')
	}

	private async api(method: string, path: string, body?: unknown): Promise<Response> {
		return fetch(`${API}/repos/${this.repo}/contents/${this.encoded(path)}${method === 'GET' ? `?ref=${encodeURIComponent(this.branch)}` : ''}`, {
			method,
			headers: {
				authorization: `Bearer ${await this.token()}`,
				accept: 'application/vnd.github+json',
				'x-github-api-version': '2022-11-28',
				'user-agent': 'recflare-github-storage',
				...(body === undefined ? {} : { 'content-type': 'application/json' })
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		})
	}

	/** File sha + size + decoded content (small files only) from the Contents API. */
	private async stat(path: string): Promise<{ sha: string; size: number; content?: Uint8Array } | null> {
		const res = await this.api('GET', path)
		if (res.status === 404) return null
		if (!res.ok) throw new Error(`GitHub storage stat ${path} failed: ${res.status}`)
		const json = (await res.json()) as {
			type?: string
			sha?: string
			size?: number
			content?: string
			encoding?: string
		}
		if (Array.isArray(json) || json.type !== 'file' || !json.sha) return null
		return {
			sha: json.sha,
			size: json.size ?? 0,
			...(json.encoding === 'base64' && json.content ? { content: fromBase64(json.content) } : {})
		}
	}

	private async readMeta(path: string): Promise<Meta> {
		const stat = await this.stat(path + META_SUFFIX)
		if (!stat?.content) return {}
		try {
			return JSON.parse(new TextDecoder().decode(stat.content)) as Meta
		} catch {
			return {}
		}
	}

	private contentTypeFor(key: string, meta: Meta): string | undefined {
		return meta.contentType ?? IMAGE_TYPES[key.split('.').pop()?.toLowerCase() ?? '']
	}

	private makeObject(key: string, info: Info, range?: { offset: number; length: number }) {
		const sha256 = info.sha256
		return {
			key,
			version: info.etag,
			size: info.size,
			etag: info.etag,
			httpEtag: `"${info.etag}"`,
			uploaded: info.uploaded,
			checksums: {
				...(sha256 ? { sha256: fromHex(sha256) } : {}),
				toJSON: () => ({ ...(sha256 ? { sha256 } : {}) })
			},
			httpMetadata: info.contentType ? { contentType: info.contentType } : {},
			customMetadata: info.custom ?? {},
			...(range ? { range } : {}),
			storageClass: 'Standard',
			writeHttpMetadata(headers: Headers) {
				if (info.contentType) headers.set('content-type', info.contentType)
			}
		}
	}

	private makeBodyObject(
		key: string,
		info: Info,
		body: ReadableStream,
		range?: { offset: number; length: number }
	) {
		const response = () => new Response(body)
		return {
			...this.makeObject(key, info, range),
			body,
			get bodyUsed() {
				return body.locked
			},
			arrayBuffer: () => response().arrayBuffer(),
			text: () => response().text(),
			json: () => response().json(),
			blob: () => response().blob()
		}
	}

	async head(key: string): Promise<unknown> {
		const path = this.path(key)
		const stat = await this.stat(path)
		if (!stat) return null
		const meta = await this.readMeta(path)
		return this.makeObject(key, {
			size: stat.size,
			etag: stat.sha,
			uploaded: new Date(),
			...meta,
			contentType: this.contentTypeFor(key, meta)
		})
	}

	async get(
		key: string,
		options?: { onlyIf?: { etagDoesNotMatch?: string }; range?: unknown }
	): Promise<unknown> {
		const path = this.path(key)
		const requested = rangeHeader(options?.range)
		const ifNoneMatch = options?.onlyIf?.etagDoesNotMatch

		const fetchRaw = async (rangeValue: string | null) =>
			fetch(`${RAW}/${this.repo}/${encodeURIComponent(this.branch)}/${this.encoded(path)}`, {
				headers: {
					authorization: `token ${await this.token()}`,
					'user-agent': 'recflare-github-storage',
					...(rangeValue ? { range: rangeValue } : {}),
					...(ifNoneMatch ? { 'if-none-match': `"${cleanEtag(ifNoneMatch)}"` } : {})
				}
			})

		const [res, meta] = await Promise.all([fetchRaw(requested), this.rawMeta(path)])
		const contentType = this.contentTypeFor(key, meta)
		const uploaded = new Date(res.headers.get('last-modified') ?? Date.now())

		if (res.status === 404) return null
		if (res.status === 304) {
			return this.makeObject(key, {
				size: 0,
				etag: cleanEtag(ifNoneMatch ?? ''),
				uploaded,
				...meta,
				contentType
			})
		}
		if (res.status === 416) return this.get(key, { ...options, range: undefined })
		if (!res.ok) throw new Error(`GitHub storage read ${path} failed: ${res.status}`)

		const etag = cleanEtag(res.headers.get('etag') ?? '') || 'unknown'
		const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') ?? '')

		if (res.status === 206 && contentRange) {
			const offset = Number(contentRange[1])
			const length = Number(contentRange[2]) - offset + 1
			return this.makeBodyObject(
				key,
				{ size: Number(contentRange[3]), etag, uploaded, ...meta, contentType },
				res.body ?? new Response(new Uint8Array()).body!,
				{ offset, length }
			)
		}

		// The host ignored the Range header and sent everything. Answering a ranged request
		// with the whole object would corrupt a chunked download, so slice it ourselves.
		if (requested) {
			const all = new Uint8Array(await res.arrayBuffer())
			const resolved = resolveRange(requested, all.byteLength)
			if (resolved) {
				const slice = all.slice(resolved.offset, resolved.offset + resolved.length)
				return this.makeBodyObject(
					key,
					{ size: all.byteLength, etag, uploaded, ...meta, contentType },
					new Response(slice).body!,
					resolved
				)
			}
			return this.makeBodyObject(
				key,
				{ size: all.byteLength, etag, uploaded, ...meta, contentType },
				new Response(all).body!
			)
		}

		return this.makeBodyObject(
			key,
			{
				size: Number(res.headers.get('content-length') ?? 0),
				etag,
				uploaded,
				...meta,
				contentType
			},
			res.body ?? new Response(new Uint8Array()).body!
		)
	}

	/** Sidecar metadata via the raw host (cheap, not rate limited). */
	private async rawMeta(path: string): Promise<Meta> {
		const res = await fetch(
			`${RAW}/${this.repo}/${encodeURIComponent(this.branch)}/${this.encoded(path + META_SUFFIX)}`,
			{
				headers: {
					authorization: `token ${await this.token()}`,
					'user-agent': 'recflare-github-storage'
				}
			}
		)
		if (!res.ok) {
			await res.body?.cancel()
			return {}
		}
		try {
			return (await res.json()) as Meta
		} catch {
			return {}
		}
	}

	/** Create or overwrite one file, retrying the conflicts and secondary limits GitHub raises. */
	private async writeFile(path: string, bytes: Uint8Array): Promise<void> {
		const content = toBase64(bytes)
		for (let attempt = 1; ; attempt++) {
			const existing = await this.stat(path)
			const res = await this.api('PUT', path, {
				message: `store ${path}`,
				content,
				branch: this.branch,
				...(existing ? { sha: existing.sha } : {})
			})
			if (res.ok) {
				await res.body?.cancel()
				return
			}
			const retryable = [409, 422, 429, 500, 502, 503, 504].includes(res.status) || res.status === 403
			const detail = await res.text()
			if (!retryable || attempt >= MAX_ATTEMPTS) {
				throw new Error(`GitHub storage write ${path} failed: ${res.status} ${detail.slice(0, 200)}`)
			}
			const retryAfter = Number(res.headers.get('retry-after') ?? 0) * 1000
			await sleep(Math.max(retryAfter, 400 * attempt + Math.random() * 400))
		}
	}

	async put(
		key: string,
		value: unknown,
		options?: {
			httpMetadata?: { contentType?: string }
			customMetadata?: Record<string, string>
			sha256?: ArrayBuffer | string
		}
	): Promise<unknown> {
		const path = this.path(key)
		const bytes = await toBytes(value)
		await this.writeFile(path, bytes)

		const sha256 =
			options?.sha256 === undefined
				? undefined
				: typeof options.sha256 === 'string'
					? options.sha256.toLowerCase()
					: toHex(options.sha256)
		const meta: Meta = {
			...(options?.httpMetadata?.contentType ? { contentType: options.httpMetadata.contentType } : {}),
			...(sha256 ? { sha256 } : {}),
			...(options?.customMetadata && Object.keys(options.customMetadata).length > 0
				? { custom: options.customMetadata }
				: {})
		}
		if (Object.keys(meta).length > 0) {
			await this.writeFile(path + META_SUFFIX, new TextEncoder().encode(JSON.stringify(meta)))
		} else {
			await this.removeFile(path + META_SUFFIX)
		}

		return this.makeObject(key, {
			size: bytes.byteLength,
			etag: 'pending',
			uploaded: new Date(),
			...meta
		})
	}

	private async removeFile(path: string): Promise<void> {
		for (let attempt = 1; ; attempt++) {
			const existing = await this.stat(path)
			if (!existing) return
			const res = await this.api('DELETE', path, {
				message: `remove ${path}`,
				sha: existing.sha,
				branch: this.branch
			})
			if (res.ok || res.status === 404) {
				await res.body?.cancel()
				return
			}
			const retryable = [409, 422, 429, 500, 502, 503, 504].includes(res.status) || res.status === 403
			if (!retryable || attempt >= MAX_ATTEMPTS) {
				throw new Error(`GitHub storage delete ${path} failed: ${res.status}`)
			}
			await res.body?.cancel()
			await sleep(400 * attempt + Math.random() * 400)
		}
	}

	async delete(keys: string | string[]): Promise<void> {
		// One at a time: concurrent commits to one branch just collide with each other.
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			const path = this.path(key)
			await this.removeFile(path)
			await this.removeFile(path + META_SUFFIX)
		}
	}
}

/**
 * The env with `CDN_ASSETS` and `IMAGES` swapped for GitHub-backed buckets, or the env itself
 * when `GITHUB_STORAGE_REPO` isn't set (so the real R2 bindings, and the test suite, are
 * untouched).
 */
export function wrapGithubStorage<E>(env: E): E {
	const e = env as unknown as GithubEnv
	if (!e || !e.GITHUB_STORAGE_REPO) return env

	const make = (prefix: string) =>
		new GithubBucket(
			e.GITHUB_STORAGE_REPO as string,
			e.GITHUB_STORAGE_BRANCH || 'main',
			prefix,
			e.GITHUB_STORAGE_TOKEN
		) as unknown as R2Bucket
	const buckets: Record<string, R2Bucket> = { CDN_ASSETS: make('cdn/'), IMAGES: make('img/') }

	return new Proxy(env as object, {
		get(target, prop) {
			if (typeof prop === 'string' && prop in buckets) return buckets[prop]
			return Reflect.get(target, prop, target)
		}
	}) as E
}

/** Hono middleware form of {@link wrapGithubStorage}; add it as the first `.use` of an app. */
export function withGithubStorage(): MiddlewareHandler {
	return async (c, next) => {
		c.env = wrapGithubStorage(c.env)
		await next()
	}
}
