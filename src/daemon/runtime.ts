import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import {
	DEFAULT_AUTH_DIR,
	DEFAULT_BAILEYS_AUTH_DIR,
	DEFAULT_DAEMON_LOCK_PATH,
	DEFAULT_DAEMON_RUNTIME_STATE_PATH,
	DEFAULT_SOCKET_PATH,
	OUTBOUND_QUEUE_INTERVAL_MS,
} from '../constants.ts'
import { getLogger } from '../logger.ts'
import { loadMembers } from '../members/loader.ts'
import { QuizEngine } from '../quiz/engine.ts'
import { loadQuizBundle } from '../quiz/loader.ts'
import { SeasonStore } from '../quiz/season-store.ts'
import type { NMember } from '../types.ts'
import { expandHome } from '../utils/path.ts'
import { WhatsAppClient } from '../whatsapp/client.ts'
import type { OutgoingMessageKey } from '../whatsapp/types.ts'
import { parseWhatsAppProvider } from '../whatsapp/types.ts'
import { type JobStatus, relayRequestSchema, type RelayResponse } from './protocol.ts'

type DaemonRuntimeOptions = {
	socketPath?: string
	authDir?: string
	provider?: string
	lockPath?: string
	statePath?: string
	fresh?: boolean
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

type JobRecord = {
	id: string
	engine: QuizEngine
	meta: {
		sources: ReadonlyArray<string>
		groupId: string
		quizDir: string
		membersFile: string | null
		noCooldown: boolean
		noSchedule: boolean
		noGeneration: boolean
		createdAt: Date
		introAt: Date | null
		firstRoundAt: Date | null
	}
}

// ---------------------------------------------------------------------------
// Runtime state snapshot — persisted to disk for crash recovery
// ---------------------------------------------------------------------------

type RuntimeStateSnapshot = {
	version: 1
	updatedAt: string
	jobs: Array<{
		id: string
		sources?: string[]
		groupId: string
		quizDir: string
		membersFile?: string | null
		noCooldown: boolean
		noSchedule: boolean
		noGeneration?: boolean
		createdAt: string
		introAt: string | null
		firstRoundAt: string | null
	}>
}

export const __runtimeTestInternals = {
	serializeSnapshot(jobs: ReadonlyMap<string, JobRecord>): RuntimeStateSnapshot {
		return serializeSnapshot(jobs)
	},
	parseSnapshotEntries(raw: string): Array<RuntimeStateSnapshot['jobs'][number]> {
		const parsed = JSON.parse(raw) as RuntimeStateSnapshot
		return parsed.jobs
	},
	/**
	 * Validate that the first round start time is not already in the past.
	 * Returns null if valid, or an error message string if invalid.
	 */
	validateSchedulingConstraints(
		firstRoundAt: Date,
		nowMs: number,
		noSchedule: boolean,
	): string | null {
		if (noSchedule) return null
		if (firstRoundAt.getTime() < nowMs) {
			return `first round start time has passed (${
				formatWibDateTime(firstRoundAt)
			} WIB). Update schedule in kotaete.ts or use --no-schedule.`
		}
		return null
	},
}

function serializeSnapshot(jobs: ReadonlyMap<string, JobRecord>): RuntimeStateSnapshot {
	return {
		version: 1,
		updatedAt: new Date().toISOString(),
		jobs: [...jobs.values()].map((job) => ({
			id: job.id,
			sources: [...(job.meta.sources ?? [job.meta.quizDir])],
			groupId: job.meta.groupId,
			quizDir: job.meta.quizDir,
			membersFile: job.meta.membersFile,
			noCooldown: job.meta.noCooldown,
			noSchedule: job.meta.noSchedule,
			...(job.meta.noGeneration ? { noGeneration: true } : {}),
			createdAt: job.meta.createdAt.toISOString(),
			introAt: job.meta.introAt?.toISOString() ?? null,
			firstRoundAt: job.meta.firstRoundAt?.toISOString() ?? null,
		})),
	}
}

export class DaemonRuntime {
	private readonly socketPath: string
	private readonly authDir: string
	private readonly lockPath: string
	private readonly statePath: string
	private readonly fresh: boolean
	private readonly wa: WhatsAppClient
	private jobs = new Map<string, JobRecord>()
	private jobCounter = 0
	private outboundQueue: Promise<OutgoingMessageKey | null> = Promise.resolve(null)
	private lastOutboundAt = 0
	private server: ReturnType<typeof createServer> | null = null
	private lockAcquired = false
	private stateSaveChain = Promise.resolve()
	private readonly seasonStore = new SeasonStore()

	constructor(options: DaemonRuntimeOptions = {}) {
		this.socketPath = expandHome(options.socketPath ?? DEFAULT_SOCKET_PATH)
		this.lockPath = expandHome(options.lockPath ?? DEFAULT_DAEMON_LOCK_PATH)
		this.statePath = expandHome(options.statePath ?? DEFAULT_DAEMON_RUNTIME_STATE_PATH)
		this.fresh = options.fresh ?? false
		const provider = parseWhatsAppProvider(options.provider)
		const defaultAuthDir = provider === 'baileys' ? DEFAULT_BAILEYS_AUTH_DIR : DEFAULT_AUTH_DIR
		this.authDir = expandHome(options.authDir ?? defaultAuthDir)

		this.wa = new WhatsAppClient({
			authDir: this.authDir,
			provider,
			onIncoming: async (incoming) => {
				const jobs = [...this.jobs.values()]
				if (jobs.length === 0) {
					const startupHint = this.fresh
						? ' (fresh mode: start one via `kotaete quiz run ...` first)'
						: ''
					log.debug(
						`incoming dropped: no active quiz jobs group=${incoming.groupId} senderLid=${
							incoming.senderLid ?? 'null'
						} senderPn=${incoming.senderNumber ?? 'null'}${startupHint}`,
					)
					return
				}
				for (const job of jobs) {
					try {
						log.debug(
							`dispatch incoming to job=${job.id} incomingGroup=${incoming.groupId} jobGroup=${job.meta.groupId}`,
						)
						await job.engine.onIncomingMessage(incoming)
					} catch (error) {
						log.error(
							`job ${job.id}: incoming message error: ${error instanceof Error ? error.message : String(error)}`,
						)
					}
				}
			},
		})
	}

	private finishJob(jobId: string): void {
		if (!this.jobs.has(jobId)) return
		this.jobs.delete(jobId)
		void this.persistState().catch(() => undefined)
	}

	private createEngineForJob(jobId: string): QuizEngine {
		return new QuizEngine({
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
		}, {
			seasonStore: this.seasonStore,
			onFinished: () => {
				this.finishJob(jobId)
			},
		})
	}

	private generateJobId(): string {
		this.jobCounter += 1
		return `q-${Date.now()}-${this.jobCounter}`
	}

	// ---------------------------------------------------------------------------
	// State persistence (atomic write: tmp + rename)
	// ---------------------------------------------------------------------------

	private async persistState(): Promise<void> {
		const snapshot = serializeSnapshot(this.jobs)
		const runSave = async () => {
			await mkdir(dirname(this.statePath), { recursive: true })
			if (snapshot.jobs.length === 0) {
				// No active jobs → remove state file
				await rm(this.statePath, { force: true }).catch(() => undefined)
				return
			}
			const tmpPath = join(dirname(this.statePath), `daemon-runtime-${randomUUID()}.tmp`)
			try {
				await writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8')
				await rename(tmpPath, this.statePath)
			} catch (error) {
				try {
					await unlink(tmpPath)
				} catch { /* ignore cleanup failure */ }
				log.warning(`failed persisting daemon runtime state: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		this.stateSaveChain = this.stateSaveChain.then(runSave, runSave)
		await this.stateSaveChain
	}

	// ---------------------------------------------------------------------------
	// State recovery
	// ---------------------------------------------------------------------------

	private async recoverJobs(): Promise<void> {
		let raw: string
		try {
			raw = await readFile(this.statePath, 'utf-8')
		} catch (error) {
			if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
				return
			}
			log.warning(`failed reading daemon runtime state: ${error instanceof Error ? error.message : String(error)}`)
			return
		}

		let parsed: RuntimeStateSnapshot
		try {
			parsed = JSON.parse(raw) as RuntimeStateSnapshot
		} catch {
			log.error('daemon runtime state file is malformed JSON — skipping recovery')
			return
		}
		if (!parsed.jobs || !Array.isArray(parsed.jobs)) {
			log.error('daemon runtime state has no valid jobs array — skipping recovery')
			return
		}

		// Deduplicate by groupId: keep latest createdAt
		const deduped = new Map<string, (typeof parsed.jobs)[number]>()
		for (const entry of parsed.jobs) {
			const prev = deduped.get(entry.groupId)
			if (!prev || entry.createdAt > prev.createdAt) {
				deduped.set(entry.groupId, entry)
			}
		}

		let recovered = 0
		for (const entry of deduped.values()) {
			try {
				const sourceList = entry.sources && entry.sources.length > 0
					? entry.sources
					: [entry.quizDir]
				const quizBundle = await loadQuizBundle(sourceList, {
					...(entry.noSchedule === undefined ? {} : { noSchedule: entry.noSchedule }),
					...(entry.noGeneration === undefined ? {} : { noGeneration: entry.noGeneration }),
				})

				let members: ReadonlyArray<NMember>
				let membersFile: string | null = entry.membersFile ?? null
				if (membersFile) {
					members = await loadMembers(membersFile)
				} else if (quizBundle.members && quizBundle.members.length > 0) {
					members = quizBundle.members
				} else if (quizBundle.membersFile) {
					membersFile = quizBundle.membersFile
					members = await loadMembers(quizBundle.membersFile)
				} else {
					throw new Error('[quiz] missing members source (set members in config or provide members file)')
				}

				const resolvedGroupId = (entry.groupId || quizBundle.groupId || '').trim()
				if (!resolvedGroupId) {
					throw new Error('[quiz] missing groupId (set groupId in config or run payload)')
				}

				const runOptions = entry.noCooldown === undefined
					? undefined
					: { noCooldown: entry.noCooldown }

				const jobId = this.generateJobId()
				const engine = this.createEngineForJob(jobId)
				const introAt = entry.introAt ? new Date(entry.introAt) : quizBundle.introAt
				const firstRoundAt = entry.firstRoundAt
					? new Date(entry.firstRoundAt)
					: (quizBundle.rounds[0]?.startAt ?? quizBundle.startAt)

				const jobRecord: JobRecord = {
					id: jobId,
					engine,
					meta: {
						sources: sourceList,
						groupId: resolvedGroupId,
						quizDir: quizBundle.directory,
						membersFile,
						noCooldown: entry.noCooldown ?? false,
						noSchedule: entry.noSchedule ?? false,
						noGeneration: entry.noGeneration ?? false,
						createdAt: entry.createdAt ? new Date(entry.createdAt) : new Date(),
						introAt,
						firstRoundAt,
					},
				}
				this.jobs.set(jobId, jobRecord)

				void engine
					.run(quizBundle, members, resolvedGroupId, runOptions)
					.catch((error: unknown) => {
						log.error(
							`recovered job ${jobId} runtime failed: ${error instanceof Error ? error.message : String(error)}`,
						)
						this.finishJob(jobId)
					})

				recovered += 1
				log.info(`recovered job ${jobId} for group ${resolvedGroupId} (original id ${entry.id})`)
			} catch (error) {
				log.error(
					`failed to recover job for group ${entry.groupId}: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		if (recovered > 0) {
			log.info(`daemon state recovery: ${recovered} job(s) recovered`)
		}
	}

	// ---------------------------------------------------------------------------
	// Job helpers
	// ---------------------------------------------------------------------------

	private getJobStatus(): JobStatus[] {
		const now = Date.now()
		return [...this.jobs.values()].map((job) => {
			const introAt = job.meta.introAt
			const firstRoundAt = job.meta.firstRoundAt
			const roundElapsed = firstRoundAt ? now - firstRoundAt.getTime() : 0
			const status: 'scheduled' | 'running' = (roundElapsed >= 0 && job.engine.isRunning()) ? 'running' : 'scheduled'
			return {
				id: job.id,
				groupId: job.meta.groupId,
				quizDir: job.meta.quizDir,
				...(job.meta.membersFile ? { membersFile: job.meta.membersFile } : {}),
				noCooldown: job.meta.noCooldown,
				...(job.meta.noGeneration ? { noGeneration: true } : {}),
				status,
				introAt: introAt?.toISOString(),
				firstRoundAt: firstRoundAt?.toISOString(),
				createdAt: job.meta.createdAt.toISOString(),
			}
		})
	}

	private findJobByGroup(groupId: string): JobRecord | undefined {
		for (const job of this.jobs.values()) {
			if (job.meta.groupId === groupId) return job
		}
		return undefined
	}

	private async forceEndJob(jobId: string): Promise<boolean> {
		const job = this.jobs.get(jobId)
		if (!job) return false
		const stopped = await job.engine.stopCurrentQuizWithFinal()
		this.finishJob(jobId)
		return stopped
	}

	// ---------------------------------------------------------------------------
	// Lock management
	// ---------------------------------------------------------------------------

	private async acquireLock(): Promise<void> {
		const payload = {
			pid: process.pid,
			provider: this.wa.provider,
			socketPath: this.socketPath,
			authDir: this.authDir,
			startedAt: new Date().toISOString(),
		}
		const serialized = `${JSON.stringify(payload)}\n`
		const attemptAcquire = async () => {
			const handle = await open(this.lockPath, 'wx')
			try {
				await handle.writeFile(serialized, 'utf-8')
			} finally {
				await handle.close().catch(() => undefined)
			}
			this.lockAcquired = true
		}

		try {
			await attemptAcquire()
			return
		} catch (error) {
			const code = error && typeof error === 'object' && 'code' in error
				? String((error as { code?: unknown }).code)
				: ''
			if (code !== 'EEXIST') throw error
		}

		const existingRaw = await readFile(this.lockPath, 'utf-8').catch(() => '')
		const existing = (() => {
			if (!existingRaw.trim()) {
				return { parsed: null as null | { pid?: number; provider?: string; socketPath?: string }, malformed: false }
			}
			try {
				return {
					parsed: JSON.parse(existingRaw) as { pid?: number; provider?: string; socketPath?: string },
					malformed: false,
				}
			} catch {
				return { parsed: null as null | { pid?: number; provider?: string; socketPath?: string }, malformed: true }
			}
		})()
		if (existing.malformed) {
			throw new Error(
				`[daemon] lock file exists but is malformed (${this.lockPath}). Remove it manually only if no daemon is running.`,
			)
		}

		const existingPid = existing.parsed?.pid
		if (typeof existingPid === 'number' && Number.isFinite(existingPid) && existingPid > 0) {
			try {
				process.kill(existingPid, 0)
				const provider = existing.parsed?.provider ?? 'unknown'
				const socketPath = existing.parsed?.socketPath ?? 'unknown'
				throw new Error(
					`[daemon] another kotaete daemon is already running (pid=${existingPid}, provider=${provider}, socket=${socketPath}). Stop it before starting a new one.`,
				)
			} catch (error) {
				const code = error && typeof error === 'object' && 'code' in error
					? String((error as { code?: unknown }).code)
					: ''
				if (code !== 'ESRCH') {
					throw error
				}
			}
		}

		await rm(this.lockPath, { force: true }).catch(() => undefined)
		await attemptAcquire()
	}

	private async releaseLock(): Promise<void> {
		if (!this.lockAcquired) return
		this.lockAcquired = false
		await rm(this.lockPath, { force: true }).catch(() => undefined)
	}

	// ---------------------------------------------------------------------------
	// Outbound queue
	// ---------------------------------------------------------------------------

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

	// ---------------------------------------------------------------------------
	// Main daemon start
	// ---------------------------------------------------------------------------

	async start(): Promise<void> {
		log.info(`Using WhatsApp provider: ${this.wa.provider}`)
		await mkdir(dirname(this.socketPath), { recursive: true })
		await mkdir(dirname(this.lockPath), { recursive: true })
		await mkdir(dirname(this.statePath), { recursive: true })
		await mkdir(this.authDir, { recursive: true })

		if (this.fresh) {
			await rm(this.statePath, { force: true }).catch(() => undefined)
			log.info('fresh mode: cleared persisted runtime state')
		}

		await this.acquireLock()

		try {
			await rm(this.socketPath, { force: true }).catch(() => undefined)

			await this.wa.start()

			// Load season points store
			await this.seasonStore.load()

			// Recover persisted jobs unless fresh mode
			if (!this.fresh) {
				await this.recoverJobs()
			}

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
								const allJobs = this.getJobStatus()
								if (allJobs.length === 0) {
									writeResponse(socket, { ok: true, message: 'no quiz jobs active', jobs: [] })
									return
								}
								const lines = allJobs.map(
									(job) =>
										`[${job.status}] ${job.id} group=${job.groupId} quizDir=${job.quizDir} cooldown=${
											job.noCooldown ? 'off' : 'on'
										} generation=${job.noGeneration ? 'off' : 'on'}`,
								)
								writeResponse(socket, {
									ok: true,
									message: `${allJobs.length} active job(s):\n${lines.join('\n')}`,
									jobs: allJobs,
								})
								return
							}

							if (parsed.data.type === 'quiz-stop') {
								const targetId = parsed.data.id
								if (targetId) {
									const stopped = await this.forceEndJob(targetId)
									if (!stopped) {
										writeResponse(socket, { ok: false, message: `no active job with id "${targetId}"` })
										return
									}
									writeResponse(socket, { ok: true, message: `job "${targetId}" stopped with final scoreboard` })
									return
								}
								const allJobs = this.getJobStatus()
								if (allJobs.length === 0) {
									writeResponse(socket, { ok: false, message: 'no active quiz jobs to stop' })
									return
								}
								if (allJobs.length === 1) {
									const jobId = allJobs[0]!.id
									await this.forceEndJob(jobId)
									writeResponse(socket, { ok: true, message: `job "${jobId}" stopped with final scoreboard` })
									return
								}
								writeResponse(socket, {
									ok: false,
									message: `multiple jobs active — pass an id to stop a specific job:\n${
										allJobs.map((j) => `  ${j.id} group=${j.groupId}`).join('\n')
									}`,
									jobs: allJobs,
								})
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

							if (!(await this.wa.isConnected())) {
								writeResponse(socket, {
									ok: false,
									message: 'WhatsApp provider is not connected yet. Wait for the connection to be established.',
								})
								return
							}

							const quizBundle = await loadQuizBundle(parsed.data.sources, {
								...(parsed.data.noSchedule === undefined ? {} : { noSchedule: parsed.data.noSchedule }),
								...(parsed.data.noGeneration === undefined ? {} : { noGeneration: parsed.data.noGeneration }),
								...(parsed.data.saveSvg ? { saveSvg: true } : {}),
							})

							const resolvedGroupId = (parsed.data.groupId ?? quizBundle.groupId ?? '').trim()
							if (!resolvedGroupId) {
								throw new Error('[quiz] missing groupId (set groupId in config or run payload)')
							}

							let members: ReadonlyArray<NMember>
							const requestedMembersFile = parsed.data.membersFile
								? expandHome(parsed.data.membersFile)
								: null
							let resolvedMembersFile: string | null = requestedMembersFile

							if (requestedMembersFile) {
								members = await loadMembers(requestedMembersFile)
							} else if (quizBundle.members && quizBundle.members.length > 0) {
								members = quizBundle.members
							} else if (quizBundle.membersFile) {
								resolvedMembersFile = quizBundle.membersFile
								members = await loadMembers(quizBundle.membersFile)
							} else {
								throw new Error('[quiz] missing members source (set members in config or provide members file)')
							}

							const existingGroupJob = this.findJobByGroup(resolvedGroupId)

							const runOptions = parsed.data.noCooldown === undefined
								? undefined
								: { noCooldown: parsed.data.noCooldown }
							const now = Date.now()
							const firstRoundAt = quizBundle.rounds[0]?.startAt ?? quizBundle.startAt

							// Scheduling guardrail: reject if first round start is already in the past
							const scheduleError = __runtimeTestInternals.validateSchedulingConstraints(
								firstRoundAt,
								now,
								parsed.data.noSchedule ?? false,
							)
							if (scheduleError) {
								writeResponse(socket, {
									ok: false,
									message: `[quiz] ${scheduleError}`,
								})
								return
							}

							if (existingGroupJob) {
								log.info(`force-ending existing job ${existingGroupJob.id} for group ${resolvedGroupId}`)
								await this.forceEndJob(existingGroupJob.id)
							}

							const introDelayMs = Math.max(0, quizBundle.introAt.getTime() - now)
							const startDelayMs = Math.max(0, firstRoundAt.getTime() - now)

							const jobId = this.generateJobId()
							const engine = this.createEngineForJob(jobId)
							const jobRecord: JobRecord = {
								id: jobId,
								engine,
								meta: {
									sources: quizBundle.sources ?? parsed.data.sources,
									groupId: resolvedGroupId,
									quizDir: quizBundle.directory,
									membersFile: resolvedMembersFile,
									noCooldown: parsed.data.noCooldown ?? false,
									noSchedule: parsed.data.noSchedule ?? false,
									noGeneration: parsed.data.noGeneration ?? false,
									createdAt: new Date(),
									introAt: quizBundle.introAt,
									firstRoundAt,
								},
							}
							this.jobs.set(jobId, jobRecord)
							void this.persistState().catch(() => undefined)

							void engine
								.run(quizBundle, members, resolvedGroupId, runOptions)
								.catch((error: unknown) => {
									log.error(`job ${jobId} runtime failed: ${error instanceof Error ? error.message : String(error)}`)
									this.finishJob(jobId)
								})

							if (parsed.data.noSchedule) {
								writeResponse(socket, {
									ok: true,
									message: `quiz running immediately (${jobId}) (--no-schedule)`,
									jobId,
								})
							} else {
								writeResponse(socket, {
									ok: true,
									message: `quiz scheduled (${jobId}) (intro ${formatWibDateTime(quizBundle.introAt)} WIB; in ${
										formatDelay(introDelayMs)
									} | round1 ${formatWibDateTime(firstRoundAt)} WIB; in ${formatDelay(startDelayMs)})`,
									jobId,
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
		} catch (error) {
			await this.releaseLock()
			throw error
		}

		const shutdown = async () => {
			log.info('Shutting down daemon...')
			await this.wa.stop()
			await new Promise<void>((resolve) => {
				this.server?.close(() => resolve())
			})
			await rm(this.socketPath, { force: true }).catch(() => undefined)
			await this.releaseLock()
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
