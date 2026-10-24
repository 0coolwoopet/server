import { useState } from 'react'

import { call, useAction } from './api'

/**
 * Developer-only "Edit users" tab: find a player by name, then change their @username and
 * display name (no limits beyond "not empty" and "not taken"), switch their roles, and give
 * them items. Every route behind it is www's developer gate — the tab being visible decides
 * nothing.
 */

/** What www's `lookupUserHandler` / `editUserHandler` answer with. */
interface EditableUser {
	accountId: number
	username: string
	displayName: string
	createdAt: string
	lastLoginTime: string | null
	availableUsernameChanges: number
	level: number
	isDeveloper: boolean
	isModerator: boolean
	isInfluencer: boolean
	hasStudio: boolean
	hasPlus: boolean
	isSandbox: boolean
	permanentStaff: boolean
}

type RoleFlag = 'isDeveloper' | 'isModerator' | 'hasStudio' | 'hasPlus' | 'isSandbox'

const ROLES: Array<{ flag: RoleFlag; label: string; hint: string; lockedForStaff?: boolean }> = [
	{ flag: 'isDeveloper', label: 'Developer', hint: 'Full staff: gifts, drops, this tab.', lockedForStaff: true },
	{ flag: 'isModerator', label: 'Moderator', hint: 'Reports, bans and warnings.', lockedForStaff: true },
	{ flag: 'hasStudio', label: 'Studio access', hint: 'May upload from Rec Room Studio.', lockedForStaff: true },
	{ flag: 'hasPlus', label: 'Rec Room Plus', hint: 'The paid tier.' },
	{ flag: 'isSandbox', label: 'Sandbox', hint: 'Served from the sandbox voice servers.' },
]

export function EditUsersForm() {
	const [name, setName] = useState('')
	const [user, setUser] = useState<EditableUser | null>(null)
	const lookup = useAction()

	return (
		<>
			<section className="card">
				<h2>Edit users</h2>
				<p className="muted">
					Enter a player&apos;s @username (or account id) and get their data, then change their
					names, roles and items. Changes are recorded in the audit log.
				</p>
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void lookup.run(async () => {
							const found = await call<EditableUser>(
								`/api/staff/users/lookup?name=${encodeURIComponent(name.trim().replace(/^@/, ''))}`,
								{ authed: true }
							)
							setUser(found)
							return `Loaded @${found.username} (#${found.accountId}).`
						})
					}}
				>
					<label>
						Username
						<input
							value={name}
							placeholder="@username"
							autoComplete="off"
							spellCheck={false}
							required
							onChange={(e) => setName(e.target.value)}
						/>
					</label>
					{lookup.error && <p className="error">{lookup.error}</p>}
					{lookup.done && <p className="ok">{lookup.done}</p>}
					<button type="submit" disabled={lookup.pending}>
						{lookup.pending ? 'Loading…' : 'Get user data'}
					</button>
				</form>
			</section>

			{user && (
				// Keyed by id so loading a different player starts every box from their values.
				<UserEditor key={user.accountId} user={user} onChange={setUser} />
			)}
		</>
	)
}

function UserEditor({
	user,
	onChange,
}: {
	user: EditableUser
	onChange: (u: EditableUser) => void
}) {
	const base = `/api/staff/users/${user.accountId}`
	const [username, setUsername] = useState(user.username)
	const [displayName, setDisplayName] = useState(user.displayName)
	const [roles, setRoles] = useState<Record<RoleFlag, boolean>>({
		isDeveloper: user.isDeveloper,
		isModerator: user.isModerator,
		hasStudio: user.hasStudio,
		hasPlus: user.hasPlus,
		isSandbox: user.isSandbox,
	})
	const [level, setLevel] = useState(String(user.level))
	const levelSave = useAction()
	const allItems = useAction()
	const [support, setSupport] = useState(user.isInfluencer)
	const supportSave = useAction()
	const [itemId, setItemId] = useState('')
	const [giftMessage, setGiftMessage] = useState('')
	const names = useAction()
	const roleSave = useAction()
	const itemGift = useAction()

	/** One PUT for whatever `fields` holds; the answer replaces the loaded user. */
	const save = async (fields: Record<string, unknown>) => {
		const res = await call<EditableUser & { changed: string[]; refused: string[] }>(base, {
			authed: true,
			method: 'PUT',
			json: fields,
		})
		onChange(res)
		return res
	}

	return (
		<>
			<section className="card">
				<h2>
					{user.displayName || user.username}{' '}
					<span className="muted">
						@{user.username} · #{user.accountId}
					</span>
				</h2>
				<p className="muted">
					Created {new Date(user.createdAt).toLocaleString()}
					{user.lastLoginTime && ` · last signed in ${new Date(user.lastLoginTime).toLocaleString()}`}
					{' · '}
					{user.availableUsernameChanges} username change
					{user.availableUsernameChanges === 1 ? '' : 's'} left (editing here doesn&apos;t spend one)
				</p>
			</section>

			<section className="card">
				<h2>Names</h2>
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void names.run(async () => {
							const res = await save({ username, displayName })
							return res.changed.length === 0
								? 'Nothing to change.'
								: `Updated ${res.changed.join(' and ')}.`
						})
					}}
				>
					<label>
						@username
						<input
							value={username}
							autoComplete="off"
							spellCheck={false}
							required
							onChange={(e) => setUsername(e.target.value)}
						/>
						<span className="hint">
							Any text, any length. It only has to be unique (not case-sensitive) — two players
							can&apos;t share a name.
						</span>
					</label>
					<label>
						Display name
						<input
							value={displayName}
							autoComplete="off"
							required
							onChange={(e) => setDisplayName(e.target.value)}
						/>
					</label>
					{names.error && <p className="error">{names.error}</p>}
					{names.done && <p className="ok">{names.done}</p>}
					<button type="submit" disabled={names.pending}>
						{names.pending ? 'Saving…' : 'Save names'}
					</button>
				</form>
			</section>

			<section className="card">
				<h2>Level</h2>
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void levelSave.run(async () => {
							const res = await save({ level: Number(level) })
							setLevel(String(res.level))
							return res.changed.includes('level')
								? `Set to level ${res.level}.`
								: 'Nothing to change.'
						})
					}}
				>
					<label>
						Level
						<input
							type="number"
							min={1}
							step={1}
							value={level}
							required
							onChange={(e) => setLevel(e.target.value)}
						/>
						<span className="hint">
							Sets the level directly and resets their progress into the next one. No level-up
							rewards are paid.
						</span>
					</label>
					{levelSave.error && <p className="error">{levelSave.error}</p>}
					{levelSave.done && <p className="ok">{levelSave.done}</p>}
					<button type="submit" disabled={levelSave.pending}>
						{levelSave.pending ? 'Saving…' : 'Save level'}
					</button>
				</form>
			</section>

			<section className="card">
				<h2>Support button</h2>
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void supportSave.run(async () => {
							const res = await save({ isInfluencer: support })
							setSupport(res.isInfluencer)
							return res.changed.includes('isInfluencer')
								? res.isInfluencer
									? 'They are now a verified creator — players can support them.'
									: 'Support button removed.'
								: 'Nothing to change.'
						})
					}}
				>
					<label>
						User has support button
						<select value={support ? 'yes' : 'no'} onChange={(e) => setSupport(e.target.value === 'yes')}>
							<option value="no">No</option>
							<option value="yes">Yes</option>
						</select>
						<span className="hint">
							Yes makes them a verified creator (the influencer partner program), so other players
							get the Support button on their profile. Takes effect on their next sign-in.
						</span>
					</label>
					{supportSave.error && <p className="error">{supportSave.error}</p>}
					{supportSave.done && <p className="ok">{supportSave.done}</p>}
					<button type="submit" disabled={supportSave.pending}>
						{supportSave.pending ? 'Saving…' : 'Save'}
					</button>
				</form>
			</section>

			<section className="card">
				<h2>Roles</h2>
				<p className="muted">
					Roles ride in the player&apos;s sign-in token, so a change reaches them the next time they
					sign in.
				</p>
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void roleSave.run(async () => {
							const res = await save(roles)
							// The server, not this form, knows which switches it refused.
							setRoles({
								isDeveloper: res.isDeveloper,
								isModerator: res.isModerator,
								hasStudio: res.hasStudio,
								hasPlus: res.hasPlus,
								isSandbox: res.isSandbox,
							})
							return res.changed.length === 0
								? 'Nothing to change.'
								: `Updated ${res.changed.join(', ')}.`
						})
					}}
				>
					{ROLES.map(({ flag, label, hint, lockedForStaff }) => {
						const locked = user.permanentStaff && lockedForStaff === true
						return (
							<label key={flag}>
								<span>
									<input
										type="checkbox"
										checked={roles[flag]}
										disabled={locked}
										onChange={(e) => setRoles({ ...roles, [flag]: e.target.checked })}
									/>{' '}
									{label}
								</span>
								<span className="hint">
									{hint}
									{locked && ' Permanent for this account — it can’t be removed.'}
								</span>
							</label>
						)
					})}
					{roleSave.error && <p className="error">{roleSave.error}</p>}
					{roleSave.done && <p className="ok">{roleSave.done}</p>}
					<button type="submit" disabled={roleSave.pending}>
						{roleSave.pending ? 'Saving…' : 'Save roles'}
					</button>
				</form>
			</section>

			<section className="card">
				<h2>Give an item</h2>
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void itemGift.run(async () => {
							const res = await call<{
								kind: 'custom_item' | 'skin' | 'consumable'
								name: string
								owned?: number
							}>(`/api/staff/players/${user.accountId}/gift-item`, {
								authed: true,
								json: { itemId: itemId.trim(), message: giftMessage.trim() || undefined },
							})
							setItemId('')
							switch (res.kind) {
								case 'skin':
									return `Sent the skin “${res.name}” to @${user.username}.`
								case 'consumable':
									return `Sent one “${res.name}” to @${user.username}. They now have ${(res.owned ?? 1).toLocaleString()}.`
								default:
									return `Sent the custom item “${res.name}” to @${user.username}.`
							}
						})
					}}
				>
					<label>
						Item id
						<input
							value={itemId}
							placeholder="Custom item, skin or consumable id"
							spellCheck={false}
							autoComplete="off"
							required
							onChange={(e) => setItemId(e.target.value)}
						/>
						<span className="hint">
							A custom avatar item&apos;s guid, a skin&apos;s modification guid, a consumable&apos;s
							item desc, or a store id. Arrives as a gift box; consumables stack.
						</span>
					</label>
					<label>
						Gift box message (optional)
						<input
							value={giftMessage}
							maxLength={256}
							autoComplete="off"
							onChange={(e) => setGiftMessage(e.target.value)}
						/>
					</label>
					{itemGift.error && <p className="error">{itemGift.error}</p>}
					{itemGift.done && <p className="ok">{itemGift.done}</p>}
					<button type="submit" disabled={itemGift.pending}>
						{itemGift.pending ? 'Sending…' : 'Give item'}
					</button>
				</form>
			</section>

			<section className="card">
				<h2>Give all items and skins</h2>
				<p className="hint">
					Unlocks every avatar item and skin in the catalog for @{user.username}, each one
					delivered as a gift box. Pressing it again sends a fresh set of boxes.
				</p>
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void allItems.run(async () => {
							const res = await call<{ items: number; skins: number; boxes: number }>(
								`/api/staff/players/${user.accountId}/give-all-items`,
								{ authed: true, json: {} }
							)
							return `Gave @${user.username} ${res.items.toLocaleString()} items and ${res.skins.toLocaleString()} skins as ${res.boxes.toLocaleString()} gift boxes.`
						})
					}}
				>
					{allItems.error && <p className="error">{allItems.error}</p>}
					{allItems.done && <p className="ok">{allItems.done}</p>}
					<button type="submit" disabled={allItems.pending}>
						{allItems.pending ? 'Giving…' : 'Give all items and skins'}
					</button>
				</form>
			</section>
		</>
	)
}
