import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { definePlugin } from '../src/plugin/define-plugin.ts'
import type { IncomingMedia } from '../src/types.ts'
import { formatSearchResults, getSearXNGConfig, searxngSearch } from '../src/utils/searxng.ts'

type Surreal = import('surrealdb').Surreal

type MemberInfo = { primaryMid: string; nickname: string }

// ── WhatsApp markdown normalizer ──────────────────────────────────────────

function normalizeForWhatsApp(text: string): string {
	// Strip markdown tables (lines starting with |)
	let out = text.replace(/(^|\n)\|.*\|\s*\n/g, '$1')
	// Strip markdown image syntax: ![alt](url) → remove entirely (images sent separately)
	out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
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
		const provider = args['provider'] ?? 'zai'
		const isCopilot = provider === 'copilot'
		const systemPromptPath = args['systemPrompt'] ?? 'AGENTS.md'
		const apiKey = args['apiKey'] ?? 'c28e5e85d9714c8abfb6408353fe54a7.dG0sZUU1Jovsvyib'
		const defaultApiUrl = isCopilot ? 'https://api.githubcopilot.com' : 'https://api.z.ai/api/coding/paas/v4/'
		const apiUrl = args['apiUrl'] ?? defaultApiUrl
		const defaultModel = isCopilot ? 'gpt-4o' : 'glm-5v-turbo'
		const model = args['model'] ?? defaultModel

		// Quiz busy message
		const busyMessage = args['busyMessage'] ?? '🐻 Kuis sedang berjalan! Boleh tanya kalau sudah selesai, ya.'

		// Rate limit config
		const maxMessages = Number(args['maxMessages'] ?? 3)
		const rateLimitResetCron = args['rateLimitResetCron'] ?? DEFAULT_RATE_LIMIT_RESET_CRON
		const adminLids = new Set((args['admins'] ?? '200729742577712@lid').split(',').map((s) => s.trim()).filter(Boolean))

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

		// Web search config (SearXNG)
		const webSearch = args['webSearch'] !== 'false'
		const searxngConfig = getSearXNGConfig({
			baseUrl: args['searxngUrl'],
			authUsername: args['searxngUsername'],
			authPassword: args['searxngPassword'],
		})
		const maxSearchRounds = Number(args['maxSearchRounds'] ?? 3)
		const searchMaxResults = Number(args['searchMaxResults'] ?? 5)
		// File reading config (LLM can read files for context)
		const fileBaseDir = resolve(args['fileBaseDir'] ?? '~/.kotaete/notes/').replace(/^~/, process.env.HOME ?? '~')
		const fileMaxSize = Number(args['fileMaxSize'] ?? 50_000)

		// Auth helper — resolves bearer token for the active provider
		async function getBearerToken(): Promise<string> {
			if (!isCopilot) return apiKey
			const { copilotAuth } = await import('../src/copilot-auth.ts')
			return copilotAuth.getSessionToken()
		}

		function getApiHeaders(token: string): Record<string, string> {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			}
			if (isCopilot) {
				headers['Copilot-Integration-Id'] = 'vscode-chat'
			}
			return headers
		}

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

		ctx.log.info(`ask: provider=${provider} model=${model} apiUrl=${apiUrl}`)
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
				const token = await getBearerToken()
				const response = await fetch(url, {
					method: 'POST',
					headers: getApiHeaders(token),
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
				const now = new Date()
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

		// Tool definitions for function calling
		const searchTools = webSearch
			? [{
				type: 'function' as const,
				function: {
					name: 'web_search',
					description:
						'Search the web for current information. Use when you need up-to-date facts, news, translations, or information you may not have in your training data. Always search when the user asks about recent events or current information.',
					parameters: {
						type: 'object',
						properties: {
							query: {
								type: 'string',
								description: 'The search query string',
							},
						},
						required: ['query'],
					},
				},
			}, {
				type: 'function' as const,
				function: {
					name: 'image_search',
					description:
						'Search for images on the web. Use when the user asks to see, show, or find a picture, photo, or visual content. The image will be sent to the user automatically as a separate message. Do NOT include image markdown or image URLs in your text response - just describe the image in your answer.',
					parameters: {
						type: 'object',
						properties: {
							query: {
								type: 'string',
								description: 'The image search query',
							},
						},
						required: ['query'],
					},
				},
			}]
			: []
		type ToolDef = {
			type: 'function'
			function: {
				name: string
				description: string
				parameters: {
					type: string
					properties: Record<string, { type: string; description: string }>
					required: string[]
				}
			}
		}
		const readFileTool: ToolDef = {
			type: 'function' as const,
			function: {
				name: 'read_file',
				description:
					'Read the contents of a file. Use when the system prompt or conversation references a file path that you need to read for additional context. The path is relative to the configured base directory.',
				parameters: {
					type: 'object',
					properties: {
						path: {
							type: 'string',
							description: 'Path to the file, relative to the base directory',
						},
					},
					required: ['path'],
				},
			},
		}
		const allTools: ToolDef[] = [...searchTools, readFileTool]

		// Track downloaded images for verification and sending
		const downloadedImages: Array<{ path: string; query: string; sourceUrl: string }> = []

		// Download an image URL to a temp file
		async function downloadImage(imageUrl: string, _query: string): Promise<string | null> {
			try {
				const resp = await fetch(imageUrl, {
					signal: AbortSignal.timeout(15_000),
					headers: { 'User-Agent': 'Kotaete/1.0' },
				})
				if (!resp.ok) return null
				const contentType = resp.headers.get('content-type') ?? ''
				if (!contentType.startsWith('image/')) return null
				const ext = contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg'
				const buffer = await resp.arrayBuffer()
				const tmpPath = `/tmp/kotaete-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
				const { writeFileSync } = await import('node:fs')
				writeFileSync(tmpPath, Buffer.from(buffer))
				ctx.log.info(`ask: downloaded image to ${tmpPath} (${buffer.byteLength} bytes)`)
				return tmpPath
			} catch (err) {
				ctx.log.warn(`ask: image download failed: ${err instanceof Error ? err.message : String(err)}`)
				return null
			}
		}

		// Execute a tool call by name
		async function executeToolCall(name: string, argsJson: string): Promise<string> {
			if (name === 'web_search') {
				const { query } = JSON.parse(argsJson) as { query: string }
				ctx.log.info(`ask: web search: "${query}"`)
				const results = await searxngSearch(query, searxngConfig, { maxResults: searchMaxResults })
				return formatSearchResults(results)
			}
			if (name === 'image_search') {
				const { query } = JSON.parse(argsJson) as { query: string }
				ctx.log.info(`ask: image search: "${query}"`)
				const results = await searxngSearch(query, searxngConfig, {
					categories: 'images',
					maxResults: 3,
				})
				if (results.results.length === 0) {
					return 'No images found for this query.'
				}
				// Try downloading the first available image
				for (const r of results.results) {
					const imgUrl = r.img_src ?? r.thumbnail ?? r.url
					if (!imgUrl) continue
					const tmpPath = await downloadImage(imgUrl, query)
					if (tmpPath) {
						downloadedImages.push({ path: tmpPath, query, sourceUrl: r.url })
						return `Found image: "${r.title}" (${r.url}). Image downloaded and ready to send.`
					}
				}
				return 'Found image results but could not download any image.'
			}
			if (name === 'read_file') {
				const { path: filePath } = JSON.parse(argsJson) as { path: string }
				const { readFileSync: readSync } = await import('node:fs')
				const { resolve: resolvePath } = await import('node:path')
				const absPath = resolvePath(fileBaseDir, filePath)
				// Security: ensure resolved path is within base dir
				if (!absPath.startsWith(resolvePath(fileBaseDir))) {
					return 'Access denied: path is outside the allowed directory.'
				}
				ctx.log.info(`ask: read_file: "${filePath}"`)
				try {
					const content = readSync(absPath, 'utf-8')
					if (content.length > fileMaxSize) {
						return content.slice(0, fileMaxSize) + `\n\n[... truncated at ${fileMaxSize} chars]`
					}
					return content
				} catch {
					return `File not found or unreadable: ${filePath}`
				}
			}
			return `Unknown tool: ${name}`
		}

		// Verify downloaded images with vision before sending
		async function verifyAndSendImages(
			question: string,
			sendImageFn: (path: string, caption: string) => Promise<void>,
		): Promise<void> {
			for (const img of downloadedImages) {
				try {
					const { readFileSync } = await import('node:fs')
					const imgBuffer = readFileSync(img.path)
					const imgBase64 = imgBuffer.toString('base64')
					const ext = img.path.split('.').pop() ?? 'jpg'
					const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'

					// Send image to LLM for verification
					const url = apiUrl.endsWith('/') ? `${apiUrl}chat/completions` : `${apiUrl}/chat/completions`
					const token = await getBearerToken()
					const verifyResponse = await fetch(url, {
						method: 'POST',
						headers: getApiHeaders(token),
						body: JSON.stringify({
							model,
							messages: [
								{
									role: 'system',
									content:
										'You are an image verification assistant. You will receive an image and the original user question. Decide if the image is appropriate and relevant. Reply with ONLY a JSON object: {"send": true/false, "caption": "WhatsApp caption for the image"}. No other text.',
								},
								{
									role: 'user',
									content: [
										{ type: 'text', text: `Original question: ${question}\n\nIs this image relevant and appropriate?` },
										{ type: 'image_url', image_url: { url: `data:${mime};base64,${imgBase64}` } },
									],
								},
							],
							temperature: 0.3,
						}),
					})

					if (!verifyResponse.ok) {
						ctx.log.warn(`ask: image verification API error: ${verifyResponse.status}`)
						continue
					}

					const vData = (await verifyResponse.json()) as any
					const vContent = (vData.choices?.[0]?.message?.content ?? '').trim()
					ctx.log.info(`ask: image verification response: ${vContent}`)

					// Parse the JSON response
					try {
						const verdict = JSON.parse(vContent) as { send?: boolean; caption?: string }
						if (verdict.send && verdict.caption) {
							await sendImageFn(img.path, verdict.caption)
							ctx.log.info(`ask: sent verified image with caption: ${verdict.caption}`)
						} else {
							ctx.log.info(`ask: image verification rejected (send=${verdict.send})`)
						}
					} catch {
						// If JSON parse fails, try to send anyway with a default caption
						ctx.log.warn(`ask: could not parse verification response, sending with default caption`)
						await sendImageFn(img.path, img.query)
					}
				} catch (err) {
					ctx.log.warn(`ask: image verification/send failed: ${err instanceof Error ? err.message : String(err)}`)
				} finally {
					// Clean up temp file
					try {
						const { unlinkSync } = await import('node:fs')
						unlinkSync(img.path)
					} catch {
						// Ignore cleanup errors
					}
				}
			}
		}

		// LLM call with function calling loop
		async function askAi(
			question: string,
			member: MemberInfo,
			media: IncomingMedia | null,
			senderLid: string,
			sourceContext: string,
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
			const token = await getBearerToken()

			// Build initial messages
			const messages: Array<Record<string, unknown>> = [
				{ role: 'system', content: systemPrompt + `\n\n[CONTEXT] Message source: ${sourceContext}` },
				...memoryMessages,
				{ role: 'user', content: buildUserContent(question, member, media) },
			]

			// Function calling loop
			for (let round = 0; round <= maxSearchRounds; round++) {
				const body: Record<string, unknown> = {
					model,
					messages,
					temperature: 0.7,
				}
				if (allTools.length > 0) {
					body.tools = allTools
				}

				const response = await fetch(url, {
					method: 'POST',
					headers: getApiHeaders(token),
					body: JSON.stringify(body),
				})
				if (!response.ok) {
					const errBody = await response.text()
					throw new Error(`API ${response.status}: ${errBody}`)
				}
				const data = (await response.json()) as any
				const choice = data.choices?.[0]
				if (!choice) return '(no response)'

				// If no tool calls or finish_reason is 'stop', return the content
				const toolCalls = choice.message?.tool_calls as
					| Array<{ id: string; function: { name: string; arguments: string } }>
					| undefined
				if (!toolCalls || toolCalls.length === 0 || choice.finish_reason === 'stop') {
					return choice.message?.content?.trim() ?? '(no response)'
				}

				// Process tool calls: add assistant message with tool_calls, then tool results
				messages.push(choice.message)
				for (const tc of toolCalls) {
					try {
						const result = await executeToolCall(tc.function.name, tc.function.arguments)
						messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err)
						ctx.log.warn(`ask: tool call failed: ${errMsg}`)
						messages.push({ role: 'tool', tool_call_id: tc.id, content: `Search error: ${errMsg}` })
					}
				}
			}

			// Exhausted rounds — return last content if available
			const lastMsg = messages[messages.length - 1]
			return typeof lastMsg?.content === 'string' ? lastMsg.content : '(no response)'
		}

		// Check if bot is among mentioned JIDs
		async function isBotMentioned(mentionedJids: string[], text: string): Promise<boolean> {
			const ownJid = ctx.getOwnJid()
			if (!ownJid) {
				// Fallback: check text for bot name
				return /@Bearcu/i.test(text)
			}
			const ownBare = ownJid.split('@')[0]?.split(':')[0] ?? ''
			for (const jid of mentionedJids) {
				const bare = jid.split('@')[0]?.split(':')[0] ?? ''
				if (bare === ownBare) return true
				// LID mentions need PN resolution to compare with bot's phone-based JID
				if (jid.endsWith('@lid')) {
					const pn = await ctx.lookupPnByLid(jid)
					if (pn) {
						const pnBare = pn.split('@')[0]?.split(':')[0] ?? ''
						if (pnBare === ownBare) return true
					}
				}
			}
			return false
		}

		// Resolve @<bare_number> mentions to member nicknames
		async function resolveMentions(text: string, mentionedJids: string[]): Promise<string> {
			if (mentionedJids.length === 0) return text
			let resolved = text
			for (const jid of mentionedJids) {
				const bare = jid.split('@')[0]?.split(':')[0] ?? ''
				if (!bare) continue

				// Try to resolve to a member name via LID lookup
				let member = await resolveMember(jid)
				// Fallback: if jid is a PN (s.whatsapp.net), try PN→LID lookup then resolveMember
				if (!member && jid.includes('@s.whatsapp.net')) {
					const lid = await ctx.lookupLidByPn(bare)
					if (lid) member = await resolveMember(lid)
				}
				// Fallback: if jid is LID-based, try LID→PN to get member by phone
				if (!member && jid.includes('@lid')) {
					const pn = await ctx.lookupPnByLid(jid)
					if (pn) member = await resolveMember(`${pn}@s.whatsapp.net`)
				}
				const displayName = member?.nickname ?? bare

				// Replace @<bare> with @<displayName>
				resolved = resolved.replace(new RegExp(`@${escapeRegExp(bare)}`, 'g'), `@${displayName}`)
			}
			return resolved
		}

		// Strip the bot's own mention from text
		function stripOwnMention(text: string): string {
			const ownJid = ctx.getOwnJid()
			if (!ownJid) return text.replace(/@Bearcu\s*/gi, '')
			const ownBare = ownJid.split('@')[0]?.split(':')[0] ?? ''
			if (!ownBare) return text
			return text.replace(new RegExp(`@${escapeRegExp(ownBare)}\\s*`, 'g'), '').replace(/@Bearcu\s*/gi, '').trim()
		}

		function escapeRegExp(str: string): string {
			return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		}

		// --- Core handler shared by group + DM ---
		async function handleAsk(
			text: string,
			media: IncomingMedia | null,
			senderLid: string | null,
			reply: (msg: string) => Promise<void>,
			reactFn: ((emoji: string) => Promise<void>) | null,
			sourceContext: string,
			sendImageFn?: (path: string, caption: string) => Promise<void>,
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

			const isAdmin = senderLid && adminLids.has(senderLid)
			if (!isAdmin) {
				const count = rateLimits.get(senderLid) ?? 0
				if (count >= maxMessages) {
					const nextResetWib = formatWibHourMinute(getNextResetAt())
					await reply(
						`🐻 Hai, ${member.nickname}. Tunggu pukul ${nextResetWib} WIB biar Bearcu bisa jawab, ya!`,
					)
					return
				}
				rateLimits.set(senderLid, count + 1)
			}

			const actualQuestion = media ? (question || '(describe this image)') : question
			const cleanQuestion = stripOwnMention(actualQuestion) || actualQuestion
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

			ctx.log.info(
				`ask: processing for ${member.nickname} (${sourceContext}) question=${JSON.stringify(effectiveQuestion)}${
					media ? ' [with image]' : ''
				})`,
			)

			try {
				const rawAnswer = await askAi(effectiveQuestion, member, media, senderLid, sourceContext)
				const answer = normalizeForWhatsApp(rawAnswer)
				await reply(answer)

				// Send verified images if any were downloaded during tool calls
				if (downloadedImages.length > 0 && sendImageFn) {
					await verifyAndSendImages(effectiveQuestion, sendImageFn)
				}

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
				ctx.log.debug(
					`ask: incoming group msg groupId=${message.groupId} senderLid=${message.senderLid ?? 'null'} senderNumber=${
						message.senderNumber ?? 'null'
					} text=${JSON.stringify(text)} mentionedJids=${JSON.stringify(message.mentionedJids)} ownJid=${
						ctx.getOwnJid() ?? 'null'
					}`,
				)
				// Group trigger: bot is among mentioned JIDs
				if (!(await isBotMentioned(message.mentionedJids, text))) return

				// Check if quiz is running
				if (await ctx.isQuizRunning(message.groupId)) {
					await ctx.sendText(message.groupId, busyMessage)
					return
				}

				// Resolve all @mentions to names
				const resolvedText = await resolveMentions(text, message.mentionedJids)
				ctx.log.debug(`ask: resolved mentions text=${JSON.stringify(resolvedText)}`)
				const cleanText = resolvedText.replace(/^\/ask\s*/, '').trim()
				const strippedQuestion = stripOwnMention(cleanText)
				if (!strippedQuestion && !message.media) return

				await handleAsk(
					resolvedText,
					message.media,
					message.senderLid,
					// Type-safe: discard return value (OutgoingMessageKey | null)
					(msg: string) => {
						void ctx.sendText(message.groupId, msg)
						return Promise.resolve()
					},
					// React takes groupId + key + emoji; wrap to only pass emoji
					(emoji) => ctx.react(message.groupId, message.key, emoji),
					`group ${message.groupId}`,
					// Send image: use group sendImageWithCaption (works with any JID)
					(path, caption) => ctx.sendImageWithCaption(message.groupId, path, caption).then(() => {}),
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
					// DM react: use reactDm with sender JID
					(emoji) => ctx.reactDm(message.senderJid, message.key, emoji),
					'personal message',
					// Send image: sendImageWithCaption works with DM JID too
					(path, caption) => ctx.sendImageWithCaption(message.senderJid, path, caption).then(() => {}),
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
