// Rewrites a wrangler config for GitHub-backed storage: drops the R2 bindings (the worker then
// gets its CDN_ASSETS / IMAGES buckets from @repo/hono-helpers' github-storage instead) and binds
// the GitHub token from the Secrets Store as GITHUB_STORAGE_TOKEN.
//
//   node github-storage-config.mjs <in-config> <out-config.json> <secrets-store-id>
//
// Prints "changed" when it wrote <out-config>, nothing when the config has no R2 bindings (the
// caller then keeps using the original). Reads JSON or JSONC; writes plain JSON beside the
// original so relative paths in it (main, migrations_dir, assets) keep resolving.
import { readFileSync, writeFileSync } from 'node:fs'

const [input, output, storeId] = process.argv.slice(2)

/** Strip // and /* *\/ comments and trailing commas without touching string contents. */
function parseJsonc(text) {
	let out = ''
	let i = 0
	while (i < text.length) {
		const c = text[i]
		if (c === '"') {
			let j = i + 1
			while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
			out += text.slice(i, j + 1)
			i = j + 1
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++
		} else if (c === '/' && text[i + 1] === '*') {
			i = text.indexOf('*/', i + 2)
			i = i === -1 ? text.length : i + 2
		} else {
			out += c
			i++
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const config = parseJsonc(readFileSync(input, 'utf8'))
if (!Array.isArray(config.r2_buckets) || config.r2_buckets.length === 0) process.exit(0)

delete config.r2_buckets

const secrets = config.secrets_store_secrets ?? []
const store = storeId || secrets.find((s) => s.store_id && s.store_id !== 'local')?.store_id
if (!store) {
	console.error('error: no Secrets Store id to bind GITHUB_STORAGE_TOKEN from (set RECFLARE_SECRETS_STORE)')
	process.exit(1)
}
if (!secrets.some((s) => s.binding === 'GITHUB_STORAGE_TOKEN')) {
	secrets.push({ binding: 'GITHUB_STORAGE_TOKEN', store_id: store, secret_name: 'GITHUB_STORAGE_TOKEN' })
}
config.secrets_store_secrets = secrets

writeFileSync(output, JSON.stringify(config, null, 2))
console.log('changed')
