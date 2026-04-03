import { mkdir, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { dirname } from 'node:path'
import {
	DEFAULT_AUTH_DIR,
	DEFAULT_BAILEYS_AUTH_DIR,
	DEFAULT_SOCKET_PATH,
	OUTBOUND_QUEUE_INTERVAL_MS,
} from '../constants.ts'
import { getLogger } from '../logger.ts'
import { loadMembers } from '../members/loader.ts'
import { QuizEngine } from '../quiz/engine.ts'
import { loadQuizBundle } from '../quiz/loader.ts'
import { expandHome } from '../utils/path.ts'
import { WhatsAppClient } from '../whatsapp/client.ts'
import type { OutgoingMessageKey } from '../whatsapp/types.ts'
import { parseWhatsAppProvider } from '../whatsapp/types.ts'
import { relayRequestSchema, type RelayResponse } from './protocol.ts'

type DaemonRuntimeOptions = {
	socketPath?: string
	authDir?: string
	provider?: string
}

const log = getLogger(['kotaete', 'daemon'])

const WIB_DATE_TIME_FMT = new Intl.DateTimeFormat('id-ID', {
	timeZone: 'Asia/Jakarta',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hour12: false,
})

function formatWibDateTime(date: Date): string {
	return WIB_DATE_TIME_FMT.format(date)
}

function formatDelay(ms: number): string {
	if (ms <= 0) return 'now'
	const totalSeconds = Math.ceil(ms / 1000)
	const hours = Math.floor(totalSeconds / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	const seconds = totalSeconds % 60
	const parts: string[] = []
	if (hours > 0) parts.push(`${hours}h`)
	if (minutes > 0) parts.push(`${minutes}m`)
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
	return parts.join(' ')
}

function writeResponse(socket: Socket, payload: RelayResponse): void {
	socket.write(`${JSON.stringify(payload)}\n`)
	socket.end()
}

export class DaemonRuntime {
	private readonly socketPath: string
	private readonly authDir: string
	private readonly quiz: QuizEngine
	private readonly wa: WhatsAppClient
	private runningQuizMeta: { groupId: string; quizDir: string; membersFile: string; disableCooldown: boolean } | null =
		null
	private outboundQueue: Promise<OutgoingMessageKey | null> = Promise.resolve(null)
	private lastOutboundAt = 0
	private server: ReturnType<typeof createServer> | null = null

	constructor(options: DaemonRuntimeOptions = {}) {
		this.socketPath = expandHome(options.socketPath ?? DEFAULT_SOCKET_PATH)
		const provider = parseWhatsAppProvider(options.provider)
		const defaultAuthDir = provider === 'baileys' ? DEFAULT_BAILEYS_AUTH_DIR : DEFAULT_AUTH_DIR
		this.authDir = expandHome(options.authDir ?? defaultAuthDir)

		this.wa = new WhatsAppClient({
			authDir: this.authDir,
			provider,
			onIncoming: async (incoming) => {
				await this.quiz.onIncomingMessage(incoming)
			},
		})
		this.quiz = new QuizEngine({
			sendText: async (groupId, text, opts) => {
				return await this.enqueueOutbound(groupId, () => this.wa.sendText(groupId, text, opts), { typing: true })
			},
			sendImageWithCaption: async (groupId, imagePath, caption) => {
				return await this.enqueueOutbound(groupId, () => this.wa.sendImageWithCaption(groupId, imagePath, caption), {
					typing: true,
				})
			},
			react: async (groupId, key, emoji) => {
				await this.wa.react(groupId, key, emoji)
			},
		})
	}

	private async enqueueOutbound(
		groupId: string,
		action: () => Promise<OutgoingMessageKey | null>,
		opts: { typing: boolean },
	): Promise<OutgoingMessageKey | null> {
		const run = async (): Promise<OutgoingMessageKey | null> => {
			if (opts.typing) {
				const earliestTypingAt = this.lastOutboundAt + 2000
				const typingDelayMs = Math.max(0, earliestTypingAt - Date.now())
				if (typingDelayMs > 0) await Bun.sleep(typingDelayMs)

				const typingStartedAt = Date.now()
				await this.wa.sendTyping(groupId).catch((error) => {
					log.debug(`sendTyping skipped: ${error instanceof Error ? error.message : String(error)}`)
				})

				const earliestByTyping = typingStartedAt + 2000
				const earliestByQueue = this.lastOutboundAt + OUTBOUND_QUEUE_INTERVAL_MS
				const sendAt = Math.max(earliestByTyping, earliestByQueue)
				const waitMs = Math.max(0, sendAt - Date.now())
				if (waitMs > 0) await Bun.sleep(waitMs)
			} else {
				const now = Date.now()
				const waitMs = Math.max(0, OUTBOUND_QUEUE_INTERVAL_MS - (now - this.lastOutboundAt))
				if (waitMs > 0) {
					await Bun.sleep(waitMs)
				}
			}
			const result = await action()
			this.lastOutboundAt = Date.now()
			return result
		}

		const next = this.outboundQueue.then(run, run)
		this.outboundQueue = next.catch(() => null)
		return await next
	}

	async start(): Promise<void> {
		log.info(`Using WhatsApp provider: ${this.wa.provider}`)
		await mkdir(dirname(this.socketPath), { recursive: true })
		await mkdir(this.authDir, { recursive: true })
		await rm(this.socketPath, { force: true }).catch(() => undefined)

		await this.wa.start()

		const server = createServer((socket) => {
			let acc = ''
			socket.on('data', (chunk) => {
				void (async () => {
					acc += chunk.toString('utf-8')
					if (!acc.includes('\n')) return

					const line = acc.split('\n')[0]?.trim() ?? ''
					acc = ''
					if (!line) {
						writeResponse(socket, { ok: false, message: 'empty payload' })
						return
					}

					try {
						const parsedJson = JSON.parse(line) as unknown
						const parsed = relayRequestSchema.safeParse(parsedJson)
						if (!parsed.success) {
							writeResponse(socket, {
								ok: false,
								message: `invalid request: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
							})
							return
						}

						if (parsed.data.type === 'quiz-status') {
							if (!this.quiz.isRunning()) {
								writeResponse(socket, { ok: true, message: 'no quiz is running' })
								return
							}
							const meta = this.runningQuizMeta
							const detail = meta
								? `running group=${meta.groupId} quizDir=${meta.quizDir} membersFile=${meta.membersFile} cooldown=${
									meta.disableCooldown ? 'off' : 'on'
								}`
								: 'quiz is running'
							writeResponse(socket, { ok: true, message: detail })
							return
						}

						if (parsed.data.type === 'quiz-stop') {
							const stopped = this.quiz.stopCurrentQuiz()
							if (!stopped) {
								writeResponse(socket, { ok: false, message: 'no active quiz to stop' })
								return
							}
							this.runningQuizMeta = null
							writeResponse(socket, { ok: true, message: 'active quiz stopped' })
							return
						}

						if (parsed.data.type === 'lookup-mapping') {
							if (!(await this.wa.isConnected())) {
								writeResponse(socket, {
									ok: false,
									message: 'WhatsApp provider is not connected yet. Start daemon and wait until it is ready.',
								})
								return
							}

							const mapped = parsed.data.direction === 'to-pn'
								? await this.wa.lookupPnByLid(parsed.data.value)
								: await this.wa.lookupLidByPn(parsed.data.value)

							if (!mapped) {
								writeResponse(socket, {
									ok: false,
									message: 'mapping not found (local cache + direct WhatsApp lookup)',
								})
								return
							}

							writeResponse(socket, {
								ok: true,
								message: mapped,
							})
							return
						}

						if (this.quiz.isRunning()) {
							writeResponse(socket, { ok: false, message: 'quiz is already running' })
							return
						}

						if (!(await this.wa.isConnected())) {
							writeResponse(socket, {
								ok: false,
								message: 'WhatsApp provider is not connected yet. Wait for the connection to be established.',
							})
							return
						}

						const members = await loadMembers(parsed.data.membersFile)
						const quizBundle = await loadQuizBundle(parsed.data.quizDir, {
							...(parsed.data.noSchedule === undefined ? {} : { noSchedule: parsed.data.noSchedule }),
						})
						const runOptions = parsed.data.disableCooldown === undefined
							? undefined
							: { disableCooldown: parsed.data.disableCooldown }
						const now = Date.now()
						const introDelayMs = Math.max(0, quizBundle.introAt.getTime() - now)
						const startDelayMs = Math.max(0, quizBundle.startAt.getTime() - now)
						this.runningQuizMeta = {
							groupId: parsed.data.groupId,
							quizDir: parsed.data.quizDir,
							membersFile: parsed.data.membersFile,
							disableCooldown: parsed.data.disableCooldown ?? false,
						}
						void this.quiz.run(quizBundle, members, parsed.data.groupId, runOptions).catch((error) => {
							log.error(`Quiz runtime failed: ${error instanceof Error ? error.message : String(error)}`)
						}).finally(() => {
							this.runningQuizMeta = null
						})
						if (parsed.data.noSchedule) {
							writeResponse(socket, { ok: true, message: 'quiz running immediately (--no-schedule)' })
						} else {
							writeResponse(socket, {
								ok: true,
								message: `quiz scheduled (intro ${formatWibDateTime(quizBundle.introAt)} WIB; in ${
									formatDelay(introDelayMs)
								} | start ${formatWibDateTime(quizBundle.startAt)} WIB; in ${formatDelay(startDelayMs)})`,
							})
						}
					} catch (error) {
						writeResponse(socket, { ok: false, message: error instanceof Error ? error.message : String(error) })
					}
				})()
			})
		})

		this.server = server

		await new Promise<void>((resolve, reject) => {
			server.once('error', reject)
			server.listen(this.socketPath, () => {
				log.info(`Daemon listening on ${this.socketPath}`)
				resolve()
			})
		})

		const shutdown = async () => {
			log.info('Shutting down daemon...')
			await this.wa.stop()
			await new Promise<void>((resolve) => {
				this.server?.close(() => resolve())
			})
			await rm(this.socketPath, { force: true }).catch(() => undefined)
			process.exit(0)
		}

		process.once('SIGINT', () => {
			void shutdown()
		})
		process.once('SIGTERM', () => {
			void shutdown()
		})

		await new Promise<void>(() => {
			// keep process alive
		})
	}
}
