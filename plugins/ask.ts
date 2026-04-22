import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { definePlugin } from '../src/plugin/define-plugin.ts'

type Surreal = import('surrealdb').Surreal

export default definePlugin({
	name: 'ask',
	version: '1.0.0',
	description: 'AI chat — /ask <question> in group (MEDRIVIA members only, rate-limited)',

	async setup(ctx, args) {
		// AI config
		const systemPromptPath = args['systemPrompt'] ?? 'AGENTS.md'
		const apiKey = args['apiKey'] ?? 'c28e5e85d9714c8abfb6408353fe54a7.dG0sZUU1Jovsvyib'
		const apiUrl = args['apiUrl'] ?? 'https://api.z.ai/api/coding/paas/v4/'
		const model = args['model'] ?? 'glm-5v-turbo'

		// Rate limit config
		const maxMessages = Number(args['maxMessages'] ?? 3)
		const windowMinutes = Number(args['windowMinutes'] ?? 10)
		const windowMs = windowMinutes * 60 * 1000

		// SurrealDB config
		const dbEndpoint = args['endpoint'] ?? 'http://localhost:596/rpc'
		const dbUsername = args['username'] ?? 'ua'
		const dbPassword = args['password'] ?? 'japan8'
		const dbNamespace = args['namespace'] ?? 'medrivia'
		const dbDatabase = args['database'] ?? 'id'

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

		// Rate limiting: lid → message count in current window
		const rateLimits = new Map<string, number>()

		// Cron: reset all counters every window
		const cronTimer = setInterval(() => {
			rateLimits.clear()
			ctx.log.debug('ask: rate limit window reset')
		}, windowMs)

		// SurrealDB connection (lazy, shared with member cache)
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

		// Member info (from SurrealDB)
		type MemberInfo = { primaryMid: string; nickname: string }

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

		// LLM call (OpenAI-compatible)
		async function askAi(question: string, member: MemberInfo): Promise<string> {
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
						{ role: 'user', content: `[${member.nickname} (${member.primaryMid})] ${question}` },
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

		return {
			async onIncomingMessage({ message }) {
				const text = message.text?.trim()
				if (!text || !text.startsWith('/ask')) return

				const question = text.replace(/^\/ask\s*/, '').trim()
				if (!question) {
					await ctx.sendText(message.groupId, '❓ Usage: /ask <question>')
					return
				}

				const senderLid = message.senderLid
				if (!senderLid) {
					ctx.log.warn('ask: no sender LID, skipping')
					return
				}

				// Membership check → resolve identity
				const member = await resolveMember(senderLid)
				if (!member) {
					await ctx.sendText(message.groupId, '❌ Kamu bukan member MEDRIVIA.')
					return
				}

				// Rate limit check
				const count = rateLimits.get(senderLid) ?? 0
				if (count >= maxMessages) {
					await ctx.sendText(
						message.groupId,
						`⏳ Rate limit tercapai (${maxMessages}/${windowMinutes} menit). Coba lagi nanti.`,
					)
					return
				}
				rateLimits.set(senderLid, count + 1)

				// React to show processing
				await ctx.react(message.groupId, message.key, '🤔')

				try {
					const answer = await askAi(question, member)
					await ctx.sendText(message.groupId, answer)
					ctx.log.info(`ask: answered for LID=${senderLid} (${question.length} chars → ${answer.length} chars)`)
				} catch (error) {
					ctx.log.error(`ask: API error: ${error instanceof Error ? error.message : String(error)}`)
					await ctx.sendText(message.groupId, '⚠️ AI error. Coba lagi nanti.')
				}
			},

			teardown() {
				clearInterval(cronTimer)
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
