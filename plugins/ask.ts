import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { definePlugin } from '../src/plugin/define-plugin.ts'
import type { IncomingMedia } from '../src/types.ts'

type Surreal = import('surrealdb').Surreal

type MemberInfo = { primaryMid: string; nickname: string }

// ── WhatsApp markdown normalizer ──────────────────────────────────────────

function normalizeForWhatsApp(text: string): string {
	// Strip markdown tables (lines starting with |)
	let out = text.replace(/(^|\n)\|.*\|\s*\n/g, '$1')
	// Strip markdown link syntax but keep visible text: [caption](url) → caption
	out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
	// Convert ##/### style headings to bold
	out = out.replace(/^#{1,3}\s+(.+)/gm, '*$1*')
	// Convert bullet list markers -/• to •
	out = out.replace(/^\s*[-*]\s+/gm, '• ')
	// Collapse 3+ newlines to 2
	out = out.replace(/\n{3,}/g, '\n\n')
	// Trim trailing whitespace per line
	out = out.replace(/[ \t]+$/gm, '')
	return out.trim()
}

// ── Memory schema (kotaete_ask_memory) ────────────────────────────────────
// Table: kotaete_ask_memory (SCHEMAFULL)
// Record ID: auto-generated SurrealDB ID
// Fields:
//   lid        TYPE string          — sender LID, unique per member
//   messages   TYPE array           — conversation entries [{role, content, ts}]
//   summary    TYPE option<string>  — auto-compacted summary (NONE when fresh)
//   created_at TYPE datetime        — record creation
//   updated_at TYPE datetime        — last write
//
// Auto-compact: when total char length of messages exceeds `memoryMaxChars`,
// the LLM generates a summary stored in `summary`, older entries are pruned
// keeping only the last `memoryKeepRecent` messages.

type MemoryEntry = {
	role: 'user' | 'assistant'
	content: string
	ts: number
}

type MemoryRecord = {
	id: string
	lid: string
	messages: MemoryEntry[]
	summary: string | null
	created_at: string
	updated_at: string
}

/** Build OpenAI-compatible user content — multimodal if media present */
function buildUserContent(
	question: string,
	member: MemberInfo,
	media: IncomingMedia | null,
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
	const prefix = `[${member.nickname} (${member.primaryMid})]`

	if (media?.base64) {
		return [
			{ type: 'text', text: `${prefix} ${question}` },
			{ type: 'image_url', image_url: { url: `data:${media.mimeType};base64,${media.base64}` } },
		]
	}

	return `${prefix} ${question}`
}

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000
const DEFAULT_RATE_LIMIT_RESET_CRON = '0,30 * * * *'

type ParsedMinuteHourCron = {
	minutes: Set<number>
	hours: Set<number>
}

function parseCronPart(part: string, min: number, max: number): Set<number> | null {
	if (part === '*') {
		const all = new Set<number>()
		for (let i = min; i <= max; i++) all.add(i)
		return all
	}

	if (part.startsWith('*/')) {
		const step = Number(part.slice(2))
		if (!Number.isInteger(step) || step <= 0) return null
		const values = new Set<number>()
		for (let i = min; i <= max; i += step) values.add(i)
		return values
	}

	const values = new Set<number>()
	for (const raw of part.split(',')) {
		const n = Number(raw.trim())
		if (!Number.isInteger(n) || n < min || n > max) return null
		values.add(n)
	}
	return values.size > 0 ? values : null
}

function parseMinuteHourCron(expr: string): ParsedMinuteHourCron | null {
	const parts = expr.trim().split(/\s+/)
	if (parts.length !== 5) return null
	const [minPart, hourPart] = parts
	const minutes = parseCronPart(minPart, 0, 59)
	const hours = parseCronPart(hourPart, 0, 23)
	if (!minutes || !hours) return null
	return { minutes, hours }
}

function formatWibHourMinute(date: Date): string {
	const wib = new Date(date.getTime() + WIB_OFFSET_MS)
	const hh = String(wib.getUTCHours()).padStart(2, '0')
	const mm = String(wib.getUTCMinutes()).padStart(2, '0')
	return `${hh}.${mm}`
}

function nextCronRunWib(parsed: ParsedMinuteHourCron, fromMs = Date.now()): Date {
	const aligned = fromMs - (fromMs % 60_000) + 60_000
	const maxSteps = 60 * 24 * 14
	for (let i = 0; i < maxSteps; i++) {
		const ts = aligned + i * 60_000
		const wib = new Date(ts + WIB_OFFSET_MS)
		if (parsed.hours.has(wib.getUTCHours()) && parsed.minutes.has(wib.getUTCMinutes())) {
			return new Date(ts)
		}
	}
	return new Date(aligned + 30 * 60_000)
}

export default definePlugin({
	name: 'ask',
	version: '2.0.0',
	description:
		'AI chat — @Bearcu mention in group, /ask in DM (MEDRIVIA members only, rate-limited, multimodal, memory-backed)',
	hookTimeoutMs: 45_000,

	async setup(ctx, args) {
		// AI config
		const systemPromptPath = args['systemPrompt'] ?? 'AGENTS.md'
		const apiKey = args['apiKey'] ?? 'c28e5e85d9714c8abfb6408353fe54a7.dG0sZUU1Jovsvyib'
		const apiUrl = args['apiUrl'] ?? 'https://api.z.ai/api/coding/paas/v4/'
		const model = args['model'] ?? 'glm-5v-turbo'

		// Rate limit config
		const maxMessages = Number(args['maxMessages'] ?? 3)
		const rateLimitResetCron = args['rateLimitResetCron'] ?? DEFAULT_RATE_LIMIT_RESET_CRON

		// Memory config
		const memoryMaxChars = Number(args['memoryMaxChars'] ?? 4000)
		const memoryKeepRecent = Number(args['memoryKeepRecent'] ?? 6)

		// SurrealDB config
		const dbEndpoint = args['endpoint'] ?? 'http://localhost:596/rpc'
		const dbUsername = args['username'] ?? 'ua'
		const dbPassword = args['password'] ?? 'japan8'
		const dbNamespace = args['namespace'] ?? 'medrivia'
		const dbDatabase = args['database'] ?? 'id'

		// Reaction emojis
		const thinkEmoji = args['thinkEmoji'] ?? '💭'
		const doneEmoji = args['doneEmoji'] ?? '✅'

		// Load system prompt
		const resolvedPath = resolve(systemPromptPath)
		let systemPrompt: string
		try {
			systemPrompt = readFileSync(resolvedPath, 'utf-8')
			ctx.log.info(`ask: loaded system prompt from ${resolvedPath} (${systemPrompt.length} chars)`)
		} catch (err) {
			ctx.log.error(
				`ask: failed to read system prompt from ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
			)
			throw new Error(`Cannot read system prompt file: ${resolvedPath}`)
		}

		// Inject WhatsApp formatting instruction into system prompt
		const waFormatInstruction = '\n\n[OUTPUT FORMAT]\nYou MUST format your replies for WhatsApp messaging.\n'
			+ '- Use *bold* for emphasis (asterisks).\n'
			+ '- Use _italic_ for subtle emphasis (underscores).\n'
			+ '- Use ~strikethrough~ for strikethrough.\n'
			+ '- Use ``` for code blocks.\n'
			+ '- NEVER use markdown tables, numbered headings (##), or [link](url) syntax.\n'
			+ '- Use simple line breaks and • for bullet lists.\n'
			+ '- Keep responses concise.\n'
			+ '- No HTML tags.\n'
		systemPrompt = systemPrompt + waFormatInstruction
		// Rate limiting: lid → message count in current window (pooled across group + DM)
		const rateLimits = new Map<string, number>()
		const parsedResetCron = parseMinuteHourCron(rateLimitResetCron)
		let resetTimer: ReturnType<typeof setTimeout> | null = null

		if (!parsedResetCron) {
			ctx.log.warn(
				`ask: invalid rateLimitResetCron="${rateLimitResetCron}"; falling back to ${DEFAULT_RATE_LIMIT_RESET_CRON}`,
			)
		}

		function getNextResetAt(): Date {
			const parsed = parsedResetCron ?? parseMinuteHourCron(DEFAULT_RATE_LIMIT_RESET_CRON)
			if (!parsed) return new Date(Date.now() + 30 * 60 * 1000)
			return nextCronRunWib(parsed)
		}

		function scheduleNextReset(): void {
			if (resetTimer) {
				clearTimeout(resetTimer)
				resetTimer = null
			}
			const nextAt = getNextResetAt()
			const delay = Math.max(1_000, nextAt.getTime() - Date.now())
			resetTimer = setTimeout(() => {
				rateLimits.clear()
				ctx.log.debug(`ask: rate limit window reset (${formatWibHourMinute(nextAt)} WIB)`)
				scheduleNextReset()
			}, delay)
		}

		// SurrealDB connection (lazy)
		let db: Surreal | null = null

		async function getDb(): Promise<Surreal> {
			if (db) return db
			const { Surreal } = await import('surrealdb') as typeof import('surrealdb')
			const instance = new Surreal()
			await instance.connect(dbEndpoint)
			await instance.signin({ username: dbUsername, password: dbPassword })
			await instance.use({ namespace: dbNamespace, database: dbDatabase })
			db = instance
			return db
		}

		// Ensure memory table exists
		async function ensureMemoryTable(): Promise<void> {
			const conn = await getDb()
			await conn.query('DEFINE TABLE kotaete_ask_memory SCHEMAFULL IF NOT EXISTS')
			await conn.query('DEFINE FIELD lid ON TYPE kotaete_ask_memory TYPE string IF NOT EXISTS')
			await conn.query('DEFINE FIELD messages ON TYPE kotaete_ask_memory TYPE array IF NOT EXISTS')
			await conn.query('DEFINE FIELD summary ON TYPE kotaete_ask_memory TYPE option<string> IF NOT EXISTS')
			await conn.query('DEFINE FIELD created_at ON TYPE kotaete_ask_memory TYPE datetime IF NOT EXISTS')
			await conn.query('DEFINE FIELD updated_at ON TYPE kotaete_ask_memory TYPE datetime IF NOT EXISTS')
		}

		const memberCache = new Map<string, MemberInfo | null>()

		async function resolveMember(lid: string): Promise<MemberInfo | null> {
			if (memberCache.has(lid)) return memberCache.get(lid) ?? null
			try {
				const conn = await getDb()
				const rows = await conn.query(
					'SELECT id, mids, nickname, meta FROM member WHERE meta.whatsapp_lid = $lid LIMIT 1',
					{ lid },
				)
				const rec = (rows as any)?.[0]?.[0] as
					| { mids?: Array<{ value: string; primary: boolean }>; nickname?: string; meta?: { kananame?: string } }
					| undefined
				if (!rec) {
					memberCache.set(lid, null)
					return null
				}
				const primaryMid = rec.mids?.find((m) => m.primary)?.value ?? rec.mids?.[0]?.value ?? '???'
				const nickname = rec.nickname ?? rec.meta?.kananame ?? primaryMid
				const info: MemberInfo = { primaryMid, nickname }
				memberCache.set(lid, info)
				return info
			} catch {
				return null
			}
		}

		// ── Memory: load recent conversation for a member ──
		async function loadMemory(lid: string): Promise<MemoryRecord | null> {
			try {
				const conn = await getDb()
				const rows = await conn.query(
					'SELECT * FROM kotaete_ask_memory WHERE lid = $lid LIMIT 1',
					{ lid },
				)
				return ((rows as any)?.[0]?.[0] as MemoryRecord) ?? null
			} catch (err) {
				ctx.log.warn(`ask: memory load failed: ${err instanceof Error ? err.message : String(err)}`)
				return null
			}
		}

		// ── Memory: save a conversation turn ──
		async function saveMemoryEntry(lid: string, entry: MemoryEntry): Promise<void> {
			try {
				const conn = await getDb()
				const existing = await loadMemory(lid)
				const now = new Date().toISOString()
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
				ctx.log.warn(`ask: memory save failed: ${err instanceof Error ? err.message : String(err)}`)
			}
		}

		// ── Memory: auto-compact when history gets long ──
		async function compactMemoryIfNeeded(lid: string): Promise<string | null> {
			const rec = await loadMemory(lid)
			if (!rec) return null

			const totalChars = rec.messages.reduce((sum, m) => sum + m.content.length, 0)
			if (totalChars <= memoryMaxChars) return rec.summary

			// Build conversation text for summarization
			const conversationText = rec.messages.map((m) => `[${m.role}]: ${m.content}`).join('\n')
			const summaryPrompt =
				`Summarize the following conversation concisely in 2-4 sentences, preserving key context and facts. Output only the summary:\n\n${conversationText}`

			try {
				const url = apiUrl.endsWith('/') ? `${apiUrl}chat/completions` : `${apiUrl}/chat/completions`
				const response = await fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
					body: JSON.stringify({ model, messages: [{ role: 'user', content: summaryPrompt }], temperature: 0.3 }),
				})
				if (!response.ok) {
					ctx.log.warn(`ask: compact API error ${response.status}`)
					return rec.summary
				}
				const data = await response.json() as any
				const summary = data.choices?.[0]?.message?.content?.trim() ?? ''
				if (!summary) return rec.summary

				// Prune older messages, keep recent ones
				const pruned = rec.messages.slice(-memoryKeepRecent)
				const now = new Date().toISOString()
				const conn = await getDb()
				await conn.query(
					'UPDATE $id SET messages = $messages, summary = $summary, updated_at = $now WHERE id = $id',
					{ id: rec.id, messages: pruned, summary, now },
				)
				ctx.log.info(`ask: compacted memory for LID=${lid} (${rec.messages.length}→${pruned.length} entries)`)
				return summary
			} catch (err) {
				ctx.log.warn(`ask: compact failed: ${err instanceof Error ? err.message : String(err)}`)
				return rec.summary
			}
		}

		// LLM call (OpenAI-compatible, multimodal, with memory context)
		async function askAi(
			question: string,
			member: MemberInfo,
			media: IncomingMedia | null,
			senderLid: string,
		): Promise<string> {
			// Build message array with memory context
			const memoryMessages: Array<{ role: string; content: string }> = []
			const rec = await loadMemory(senderLid)
			if (rec?.summary) {
				memoryMessages.push({ role: 'system', content: `[Previous conversation summary]\n${rec.summary}` })
			}
			if (rec?.messages.length) {
				const recent = rec.messages.slice(-memoryKeepRecent)
				for (const m of recent) {
					memoryMessages.push({ role: m.role, content: m.content })
				}
			}

			const url = apiUrl.endsWith('/') ? `${apiUrl}chat/completions` : `${apiUrl}/chat/completions`
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model,
					messages: [
						{ role: 'system', content: systemPrompt },
						...memoryMessages,
						{ role: 'user', content: buildUserContent(question, member, media) },
					],
					temperature: 0.7,
				}),
			})
			if (!response.ok) {
				const body = await response.text()
				throw new Error(`API ${response.status}: ${body}`)
			}
			const data = await response.json() as any
			return data.choices?.[0]?.message?.content?.trim() ?? '(no response)'
		}

		// Check if text triggers the bot in group (mention-based)
		function isGroupTrigger(text: string): boolean {
			const mentionPatterns = [
				/@Bearcu/i,
				/@\d+@s\.whatsapp\.net/i,
				/@\w+@lid/i,
			]
			return mentionPatterns.some((re) => re.test(text))
		}

		// Strip mention text from the question
		function stripMention(text: string): string {
			return text.replace(/@Bearcu\s*/gi, '').replace(/@\S+\s*/g, '').trim()
		}

		// --- Core handler shared by group + DM ---
		async function handleAsk(
			text: string,
			media: IncomingMedia | null,
			senderLid: string | null,
			reply: (msg: string) => Promise<void>,
			reactFn: ((emoji: string) => Promise<void>) | null,
		): Promise<void> {
			const question = text.replace(/^\/ask\s*/, '').trim()
			if (!question && !media) {
				await reply('❓ Ketik /ask <pertanyaan> (DM) atau mention @Bearcu di grup.')
				return
			}

			if (!senderLid) {
				ctx.log.warn('ask: no sender LID, skipping')
				return
			}

			const member = await resolveMember(senderLid)
			if (!member) {
				await reply('❌ Kamu bukan member MEDRIVIA.')
				return
			}

			// Rate limit (pooled across group + DM by LID)
			const count = rateLimits.get(senderLid) ?? 0
			if (count >= maxMessages) {
				const nextResetWib = formatWibHourMinute(getNextResetAt())
				await reply(
					`Hai, ${member.nickname}, tunggu pukul ${nextResetWib} WIB biar Bearcu bisa jawab lagi, ya!`,
				)
				return
			}
			rateLimits.set(senderLid, count + 1)

			const actualQuestion = media ? (question || '(describe this image)') : question
			const cleanQuestion = stripMention(actualQuestion) || actualQuestion
			const effectiveQuestion = cleanQuestion || '(no text)'
			const now = Date.now()

			// Save user message to memory
			await saveMemoryEntry(senderLid, { role: 'user', content: effectiveQuestion, ts: now })
			// Auto-compact if memory is getting long
			await compactMemoryIfNeeded(senderLid)

			// React 💭 before processing
			try {
				if (reactFn) await reactFn(thinkEmoji)
			} catch {
				// Non-fatal: reaction failure must not block
			}

			try {
				const rawAnswer = await askAi(effectiveQuestion, member, media, senderLid)
				const answer = normalizeForWhatsApp(rawAnswer)
				await reply(answer)

				// Save assistant reply to memory
				await saveMemoryEntry(senderLid, { role: 'assistant', content: answer, ts: Date.now() })
				// React ✅ after successful response
				try {
					if (reactFn) await reactFn(doneEmoji)
				} catch {
					// Non-fatal
				}

				ctx.log.info(
					`ask: answered for LID=${senderLid} (${effectiveQuestion.length} chars, ${
						media ? 'with image' : 'text-only'
					} → ${answer.length} chars)`,
				)
			} catch (error) {
				ctx.log.error(`ask: API error: ${error instanceof Error ? error.message : String(error)}`)
				await reply('⚠️ AI error. Coba lagi nanti.')
			}
		}

		// Initialize memory table on setup
		await ensureMemoryTable()
		ctx.log.info('ask: memory table ensured')
		scheduleNextReset()
		ctx.log.info(`ask: rate limit reset cron = ${rateLimitResetCron}`)

		return {
			async onIncomingMessage({ message }) {
				const text = message.text?.trim() ?? ''
				// Group trigger: mention bot identity, not /ask prefix
				if (!isGroupTrigger(text)) return

				const cleanText = text.replace(/^\/ask\s*/, '').trim()
				const strippedQuestion = stripMention(cleanText)
				if (!strippedQuestion && !message.media) return

				await handleAsk(
					text,
					message.media,
					message.senderLid,
					// Type-safe: discard return value (OutgoingMessageKey | null)
					(msg: string) => {
						void ctx.sendText(message.groupId, msg)
						return Promise.resolve()
					},
					// React takes groupId + key + emoji; wrap to only pass emoji
					(emoji) => ctx.react(message.groupId, message.key, emoji),
				)
			},

			async onIncomingDmMessage({ message }) {
				const text = message.text?.trim() ?? ''
				// DM trigger: /ask prefix
				if (!text.startsWith('/ask')) return

				await handleAsk(
					text,
					message.media,
					message.senderLid,
					// Type-safe: discard return value (OutgoingMessageKey | null)
					(msg: string) => {
						void ctx.sendDmText(message.senderJid, msg)
						return Promise.resolve()
					},
					null, // no react in DM
				)
			},

			teardown() {
				if (resetTimer) {
					clearTimeout(resetTimer)
					resetTimer = null
				}
				memberCache.clear()
				rateLimits.clear()
				if (db) {
					void db.close()
					db = null
				}
			},
		}
	},
})
