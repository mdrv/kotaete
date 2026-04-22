import { definePlugin } from '../../src/plugin/define-plugin.ts'
import { parseAskArgs } from './config.ts'
import { handleAsk } from './handler.ts'
import { ensureMemoryTable, getDb } from './memory.ts'
import { isBotMentioned, resolveMentions, stripOwnMention } from './mention.ts'
import type { AskContext, ParsedMinuteHourCron } from './types.ts'
import { DEFAULT_RATE_LIMIT_RESET_CRON, nextCronRunWib, parseMinuteHourCron } from './utils.ts'

export default definePlugin({
	name: 'ask',
	version: '2.0.0',
	description:
		'AI chat — @Bearcu mention in group, /ask in DM (MEDRIVIA members only, rate-limited, multimodal, memory-backed)',
	hookTimeoutMs: 45_000,

	async setup(ctx, args) {
		const config = parseAskArgs(args)

		ctx.log.info(`ask: provider=${config.provider} model=${config.model} apiUrl=${config.apiUrl}`)
		ctx.log.info(`ask: loaded system prompt (${config.systemPrompt.length} chars)`)

		// Mutable state
		const rateLimits = new Map<string, number>()
		const memberCache = new Map<string, import('./types.ts').MemberInfo | null>()
		const db: { current: import('./types.ts').Surreal | null } = { current: null }
		const resetTimer: { current: ReturnType<typeof setTimeout> | null } = { current: null }
		const downloadedImages: Array<{ path: string; query: string; sourceUrl: string }> = []
		const closedMessage: { current: string | undefined } = { current: undefined }
		const _parsedResetCron: ParsedMinuteHourCron | null = parseMinuteHourCron(config.rateLimitResetCron)

		if (!_parsedResetCron) {
			ctx.log.warn(
				`ask: invalid rateLimitResetCron="${config.rateLimitResetCron}"; falling back to ${DEFAULT_RATE_LIMIT_RESET_CRON}`,
			)
		}

		const ac: AskContext = {
			ctx,
			config,
			db,
			memberCache,
			rateLimits,
			resetTimer,
			downloadedImages,
			closedMessage,
			_parsedResetCron,
		}

		// Rate limit reset scheduling
		function scheduleNextReset(): void {
			if (resetTimer.current) {
				clearTimeout(resetTimer.current)
				resetTimer.current = null
			}
			const nextAt = getNextResetAt()
			const delay = Math.max(1_000, nextAt.getTime() - Date.now())
			resetTimer.current = setTimeout(() => {
				rateLimits.clear()
				ctx.log.debug(`ask: rate limit window reset`)
				scheduleNextReset()
			}, delay)
		}

		function getNextResetAt(): Date {
			const parsed = _parsedResetCron ?? parseMinuteHourCron(DEFAULT_RATE_LIMIT_RESET_CRON)
			if (!parsed) return new Date(Date.now() + 30 * 60 * 1000)
			return nextCronRunWib(parsed)
		}

		// Initialize memory table on setup
		await ensureMemoryTable(ac)
		ctx.log.info('ask: memory table ensured')
		scheduleNextReset()
		ctx.log.info(`ask: rate limit reset cron = ${config.rateLimitResetCron}`)

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
				if (!(await isBotMentioned(ac, message.mentionedJids, text))) return

				// Check if quiz is running
				if (await ctx.isQuizRunning(message.groupId)) {
					await ctx.sendText(message.groupId, config.busyMessage)
					return
				}

				// Resolve all @mentions to names
				const resolvedText = await resolveMentions(ac, text, message.mentionedJids)
				ctx.log.debug(`ask: resolved mentions text=${JSON.stringify(resolvedText)}`)
				const cleanText = resolvedText.replace(/^\/ask\s*/, '').trim()
				const strippedQuestion = stripOwnMention(ac, cleanText)
				if (!strippedQuestion && !message.media) return

				await handleAsk(
					ac,
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
					message.groupId,
				)
			},

			async onIncomingDmMessage({ message }) {
				const text = message.text?.trim() ?? ''
				// DM trigger: /ask prefix
				if (!text.startsWith('/ask')) return

				await handleAsk(
					ac,
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
				if (resetTimer.current) {
					clearTimeout(resetTimer.current)
					resetTimer.current = null
				}
				memberCache.clear()
				rateLimits.clear()
				if (db.current) {
					void db.current.close()
					db.current = null
				}
			},

			// Exposed tools (callable via CLI: kotaete x ask tool <name> [args])
			get closedMessage() {
				return closedMessage.current
			},
			set closedMessage(msg: string | undefined) {
				closedMessage.current = msg
			},
			tools: {
				async get_member_info(cliArgs: string[]): Promise<string> {
					const mid = cliArgs[0]
					if (!mid) return 'Usage: get_member_info <mid>'
					const cleanMid = mid.trim().toLowerCase()
					try {
						const conn = await getDb(ac)
						const rows = await conn.query(
							'SELECT nickname, mids, meta FROM member WHERE mids[*].value CONTAINS $mid LIMIT 1',
							{ mid: cleanMid },
						)
						const rec = (rows as any)?.[0]?.[0] as
							| {
								nickname?: string
								mids?: Array<{ value: string; primary: boolean }>
								meta?: { kananame?: string; classgroup?: string }
							}
							| undefined
						if (!rec) return `Member not found: ${cleanMid}`
						const primaryMid = rec.mids?.find((m) => m.primary)?.value ?? rec.mids?.[0]?.value ?? cleanMid
						const lines = [
							`Nickname: ${rec.nickname ?? '-'}`,
							`MID: ${primaryMid}`,
							`Kananame: ${rec.meta?.kananame ?? '-'}`,
							`Class/Group: ${rec.meta?.classgroup ?? '-'}`,
						]
						return lines.join('\n')
					} catch (err) {
						return `Error: ${err instanceof Error ? err.message : String(err)}`
					}
				},
			},
		}
	},
})
