import type { AskContext } from './types.ts'
import type { MemberInfo, MemoryEntry, MemoryRecord, Surreal } from './types.ts'

// ── SurrealDB connection (lazy) ───────────────────────────────────────────

export async function getDb(ac: AskContext): Promise<Surreal> {
	if (ac.db.current) return ac.db.current
	const { Surreal } = await import('surrealdb') as typeof import('surrealdb')
	const instance = new Surreal()
	await instance.connect(ac.config.dbEndpoint)
	await instance.signin({ username: ac.config.dbUsername, password: ac.config.dbPassword })
	await instance.use({ namespace: ac.config.dbNamespace, database: ac.config.dbDatabase })
	ac.db.current = instance
	return instance
}

// ── Ensure memory tables exist ────────────────────────────────────────────

export async function ensureMemoryTable(ac: AskContext): Promise<void> {
	const conn = await getDb(ac)
	// Per-user memory (personal conversation history)
	await conn.query('DEFINE TABLE IF NOT EXISTS kotaete_ask_memory SCHEMAFULL')
	await conn.query('DEFINE FIELD IF NOT EXISTS lid ON kotaete_ask_memory TYPE string')
	await conn.query('DEFINE FIELD IF NOT EXISTS messages ON kotaete_ask_memory TYPE array')
	await conn.query('DEFINE FIELD IF NOT EXISTS messages[*] ON kotaete_ask_memory TYPE object')
	await conn.query('DEFINE FIELD IF NOT EXISTS messages[*].role ON kotaete_ask_memory TYPE string')
	await conn.query('DEFINE FIELD IF NOT EXISTS messages[*].content ON kotaete_ask_memory TYPE string')
	await conn.query('DEFINE FIELD IF NOT EXISTS messages[*].ts ON kotaete_ask_memory TYPE number')
	await conn.query('DEFINE FIELD IF NOT EXISTS summary ON kotaete_ask_memory TYPE option<string>')
	await conn.query('DEFINE FIELD IF NOT EXISTS created_at ON kotaete_ask_memory TYPE datetime')
	await conn.query('DEFINE FIELD IF NOT EXISTS updated_at ON kotaete_ask_memory TYPE datetime')
	// Per-group memory (shared conversation history across members)
	await conn.query('DEFINE TABLE IF NOT EXISTS kotaete_ask_group_memory SCHEMAFULL')
	await conn.query('DEFINE FIELD IF NOT EXISTS group_id ON kotaete_ask_group_memory TYPE string')
	await conn.query('DEFINE FIELD IF NOT EXISTS messages ON kotaete_ask_group_memory TYPE array')
	await conn.query('DEFINE FIELD IF NOT EXISTS messages[*] ON kotaete_ask_group_memory TYPE object')
	await conn.query('DEFINE FIELD IF NOT EXISTS messages[*].role ON kotaete_ask_group_memory TYPE string')
	await conn.query('DEFINE FIELD IF NOT EXISTS messages[*].content ON kotaete_ask_group_memory TYPE string')
	await conn.query('DEFINE FIELD IF NOT EXISTS messages[*].ts ON kotaete_ask_group_memory TYPE number')
	await conn.query(
		'DEFINE FIELD IF NOT EXISTS messages[*].nickname ON kotaete_ask_group_memory TYPE option<string>',
	)
	await conn.query('DEFINE FIELD IF NOT EXISTS summary ON kotaete_ask_group_memory TYPE option<string>')
	await conn.query('DEFINE FIELD IF NOT EXISTS created_at ON kotaete_ask_group_memory TYPE datetime')
	await conn.query('DEFINE FIELD IF NOT EXISTS updated_at ON kotaete_ask_group_memory TYPE datetime')
}

// ── Member resolution ─────────────────────────────────────────────────────

export async function resolveMember(ac: AskContext, lid: string): Promise<MemberInfo | null> {
	if (ac.memberCache.has(lid)) return ac.memberCache.get(lid) ?? null
	try {
		const conn = await getDb(ac)
		const rows = await conn.query(
			'SELECT id, mids, nickname, meta FROM member WHERE meta.whatsapp_lid = $lid LIMIT 1',
			{ lid },
		)
		const rec = (rows as any)?.[0]?.[0] as
			| { mids?: Array<{ value: string; primary: boolean }>; nickname?: string; meta?: { kananame?: string } }
			| undefined
		if (!rec) {
			ac.memberCache.set(lid, null)
			return null
		}
		const primaryMid = rec.mids?.find((m) => m.primary)?.value ?? rec.mids?.[0]?.value ?? '???'
		const nickname = rec.nickname ?? rec.meta?.kananame ?? primaryMid
		const info: MemberInfo = { primaryMid, nickname }
		ac.memberCache.set(lid, info)
		return info
	} catch {
		return null
	}
}

// ── Memory: load recent conversation for a member ─────────────────────────

export async function loadMemory(ac: AskContext, lid: string): Promise<MemoryRecord | null> {
	try {
		const conn = await getDb(ac)
		const rows = await conn.query(
			'SELECT * FROM kotaete_ask_memory WHERE lid = $lid LIMIT 1',
			{ lid },
		)
		return ((rows as any)?.[0]?.[0] as MemoryRecord) ?? null
	} catch (err) {
		ac.ctx.log.warn(`ask: memory load failed: ${err instanceof Error ? err.message : String(err)}`)
		return null
	}
}

// ── Memory: save a conversation turn ──────────────────────────────────────

export async function saveMemoryEntry(ac: AskContext, lid: string, entry: MemoryEntry): Promise<void> {
	try {
		const conn = await getDb(ac)
		const existing = await loadMemory(ac, lid)
		const now = new Date()
		if (existing) {
			const updatedMessages = [...existing.messages, entry]
			await conn.query(
				'UPDATE $id SET messages = $messages, updated_at = $now WHERE id = $id',
				{ id: existing.id, messages: updatedMessages, now },
			)
		} else {
			await conn.query(
				'CREATE kotaete_ask_memory SET lid = $lid, messages = [$entry], summary = NONE, created_at = $now, updated_at = $now',
				{ lid, entry, now },
			)
		}
	} catch (err) {
		ac.ctx.log.warn(`ask: memory save failed: ${err instanceof Error ? err.message : String(err)}`)
	}
}

// ── Group Memory: load shared conversation for a group ────────────────────

export async function loadGroupMemory(ac: AskContext, groupId: string): Promise<MemoryRecord | null> {
	try {
		const conn = await getDb(ac)
		const rows = await conn.query(
			'SELECT * FROM kotaete_ask_group_memory WHERE group_id = $groupId LIMIT 1',
			{ groupId },
		)
		return ((rows as any)?.[0]?.[0] as MemoryRecord) ?? null
	} catch (err) {
		ac.ctx.log.warn(`ask: group memory load failed: ${err instanceof Error ? err.message : String(err)}`)
		return null
	}
}

// ── Group Memory: save a conversation turn to group ───────────────────────

export async function saveGroupMemoryEntry(
	ac: AskContext,
	groupId: string,
	entry: MemoryEntry & { nickname?: string },
): Promise<void> {
	try {
		const conn = await getDb(ac)
		const existing = await loadGroupMemory(ac, groupId)
		const now = new Date()
		if (existing) {
			const updatedMessages = [...existing.messages, entry]
			await conn.query(
				'UPDATE $id SET messages = $messages, updated_at = $now WHERE id = $id',
				{ id: existing.id, messages: updatedMessages, now },
			)
		} else {
			await conn.query(
				'CREATE kotaete_ask_group_memory SET group_id = $groupId, messages = [$entry], summary = NONE, created_at = $now, updated_at = $now',
				{ groupId, entry, now },
			)
		}
	} catch (err) {
		ac.ctx.log.warn(`ask: group memory save failed: ${err instanceof Error ? err.message : String(err)}`)
	}
}

// ── Memory: auto-compact when history gets long ───────────────────────────

export async function compactMemoryIfNeeded(ac: AskContext, lid: string): Promise<string | null> {
	const rec = await loadMemory(ac, lid)
	if (!rec) return null

	const totalChars = rec.messages.reduce((sum, m) => sum + m.content.length, 0)
	if (totalChars <= ac.config.memoryMaxChars) return rec.summary

	// Build conversation text for summarization
	const conversationText = rec.messages.map((m) => `[${m.role}]: ${m.content}`).join('\n')
	const summaryPrompt =
		`Summarize the following conversation concisely in 2-4 sentences, preserving key context and facts. Output only the summary:\n\n${conversationText}`

	try {
		const { apiUrl, model } = ac.config
		const url = apiUrl.endsWith('/') ? `${apiUrl}chat/completions` : `${apiUrl}/chat/completions`
		const token = await getBearerToken(ac)
		const response = await fetch(url, {
			method: 'POST',
			headers: getApiHeaders(ac, token),
			body: JSON.stringify({ model, messages: [{ role: 'user', content: summaryPrompt }], temperature: 0.3 }),
		})
		if (!response.ok) {
			ac.ctx.log.warn(`ask: compact API error ${response.status}`)
			return rec.summary
		}
		const data = await response.json() as any
		const summary = data.choices?.[0]?.message?.content?.trim() ?? ''
		if (!summary) return rec.summary

		// Prune older messages, keep recent ones
		const pruned = rec.messages.slice(-ac.config.memoryKeepRecent)
		const now = new Date()
		const conn = await getDb(ac)
		await conn.query(
			'UPDATE $id SET messages = $messages, summary = $summary, updated_at = $now WHERE id = $id',
			{ id: rec.id, messages: pruned, summary, now },
		)
		ac.ctx.log.info(`ask: compacted memory for LID=${lid} (${rec.messages.length}→${pruned.length} entries)`)
		return summary
	} catch (err) {
		ac.ctx.log.warn(`ask: compact failed: ${err instanceof Error ? err.message : String(err)}`)
		return rec.summary
	}
}

// ── Auth helpers (used by memory compact) ─────────────────────────────────

export async function getBearerToken(ac: AskContext): Promise<string> {
	if (!ac.config.isCopilot) return ac.config.apiKey
	const { copilotAuth } = await import('../../src/copilot-auth.ts')
	return copilotAuth.getSessionToken()
}

export function getApiHeaders(ac: AskContext, token: string): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${token}`,
	}
	if (ac.config.isCopilot) {
		headers['Copilot-Integration-Id'] = 'vscode-chat'
	}
	return headers
}
