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
import { PluginManager } from '../plugin/manager.ts'
import { QuizEngine } from '../quiz/engine.ts'
import type { QuizEventLogger } from '../quiz/event-logger.ts'
import { loadQuizBundle } from '../quiz/loader.ts'
import { SeasonStore } from '../quiz/season-store.ts'
import type { NMember, QuizBundle } from '../types.ts'
import { expandHome } from '../utils/path.ts'
import { WhatsAppClient } from '../whatsapp/client.ts'
import type { OutgoingMessageKey, WhatsAppProvider } from '../whatsapp/types.ts'
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

type DeferredPayload = {
	quizBundle: QuizBundle
	members: ReadonlyArray<NMember>
	runOptions: { noCooldown: boolean } | undefined
}

export type JobRecord = {
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
	deferred: DeferredPayload | null
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
	/**
	 * Create an isolated queue context that mirrors DaemonRuntime's per-group queue
	 * logic. No side effects (no network, filesystem, timers). Useful for testing
	 * queue ordering, advancement, and clearing behavior.
	 */
	createQueueTestContext,
	computeStopSilenceFromStatus(
		firstRoundAt: Date | null,
		nowMs: number,
		isRunning: boolean,
		requestedSilent?: boolean,
	): boolean {
		const roundElapsed = firstRoundAt ? nowMs - firstRoundAt.getTime() : 0
		const effectiveRunning = roundElapsed >= 0 && isRunning
		return (requestedSilent ?? false) || !effectiveRunning
	},
}

/** ---------------------------------------------------------------------------
 * Pure-function reimplementation of the per-group queue logic for testing.
 * Mirrors the private methods on DaemonRuntime without requiring a full
 * instance (no WhatsApp client, no filesystem, no timers).
 * ---------------------------------------------------------------------------
 */
type QueueTestContext = {
	jobs: Map<string, JobRecord>
	groupQueues: Map<string, string[]>
	addToQueue(jobId: string, groupId: string): number
	removeFromQueue(jobId: string, groupId: string): void
	getActiveJobIdForGroup(groupId: string): string | undefined
	isActiveJob(jobId: string, groupId: string): boolean
	finishJob(jobId: string): void
	advanceQueue(groupId: string): void
	clearGroupQueue(groupId: string): void
	getJobStatus(): JobStatus[]
}

function createQueueTestContext(): QueueTestContext {
	const jobs = new Map<string, JobRecord>()
	const groupQueues = new Map<string, string[]>()
	const startedJobs = new Set<string>()

	function addToQueue(jobId: string, groupId: string): number {
		const queue = groupQueues.get(groupId) ?? []
		queue.push(jobId)
		queue.sort((a, b) => {
			const jobA = jobs.get(a)
			const jobB = jobs.get(b)
			const atA = jobA?.meta.firstRoundAt?.getTime() ?? Infinity
			const atB = jobB?.meta.firstRoundAt?.getTime() ?? Infinity
			return atA - atB
		})
		groupQueues.set(groupId, queue)
		return queue.indexOf(jobId)
	}

	function removeFromQueue(jobId: string, groupId: string): void {
		const queue = groupQueues.get(groupId)
		if (!queue) return
		const idx = queue.indexOf(jobId)
		if (idx >= 0) queue.splice(idx, 1)
		if (queue.length === 0) {
			groupQueues.delete(groupId)
		}
	}

	function getActiveJobIdForGroup(groupId: string): string | undefined {
		const queue = groupQueues.get(groupId)
		return queue?.[0]
	}

	function isActiveJob(jobId: string, groupId: string): boolean {
		return getActiveJobIdForGroup(groupId) === jobId
	}

	function finishJob(jobId: string): void {
		const job = jobs.get(jobId)
		if (!job) return
		const groupId = job.meta.groupId
		startedJobs.delete(jobId)
		removeFromQueue(jobId, groupId)
		jobs.delete(jobId)
		advanceQueue(groupId)
	}

	function advanceQueue(groupId: string): void {
		const queue = groupQueues.get(groupId)
		if (!queue || queue.length === 0) return
		const nextJobId = queue[0]!
		const nextJob = jobs.get(nextJobId)
		if (!nextJob || !nextJob.deferred) return
		nextJob.deferred = null
		startedJobs.add(nextJobId)
	}

	function clearGroupQueue(groupId: string): void {
		const queue = groupQueues.get(groupId)
		if (!queue) return
		for (const jobId of queue) {
			jobs.delete(jobId)
			startedJobs.delete(jobId)
		}
		groupQueues.delete(groupId)
	}

	function getJobStatus(): JobStatus[] {
		return [...jobs.values()].map((job) => {
			const queue = groupQueues.get(job.meta.groupId) ?? []
			const queuePosition = queue.indexOf(job.id)
			const running = startedJobs.has(job.id)
			const result: JobStatus = {
				id: job.id,
				groupId: job.meta.groupId,
				quizDir: job.meta.quizDir,
				...(job.meta.membersFile ? { membersFile: job.meta.membersFile } : {}),
				noCooldown: job.meta.noCooldown,
				...(job.meta.noGeneration ? { noGeneration: true } : {}),
				...(queuePosition >= 0 ? { queuePosition } : {}),
				status: (running ? 'running' : 'scheduled') as 'scheduled' | 'running',
				introAt: job.meta.introAt?.toISOString(),
				firstRoundAt: job.meta.firstRoundAt?.toISOString(),
				createdAt: job.meta.createdAt.toISOString(),
			}
			return result
		})
	}

	return {
		jobs,
		groupQueues,
		addToQueue,
		removeFromQueue,
		getActiveJobIdForGroup,
		isActiveJob,
		finishJob,
		advanceQueue,
		clearGroupQueue,
		getJobStatus,
	}
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
	private readonly pluginManager: PluginManager
	private jobs = new Map<string, JobRecord>()
	private groupQueues = new Map<string, string[]>()
	private jobCounter = 0
	private outboundQueue: Promise<OutgoingMessageKey | null> = Promise.resolve(null)
	private lastOutboundAt = 0
	private server: ReturnType<typeof createServer> | null = null
	private lockAcquired = false
	private stateSaveChain = Promise.resolve()
	private readonly seasonStore = new SeasonStore()
	private eventLogger: QuizEventLogger | null = null

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
				// Plugin hooks are fire-and-forget, non-blocking
				this.pluginManager.emitIncoming(incoming)

				const jobs = [...this.jobs.values()].filter((job) => this.isActiveJob(job.id, job.meta.groupId))
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
							`dispatch incoming to active job=${job.id} incomingGroup=${incoming.groupId} jobGroup=${job.meta.groupId}`,
						)
						await job.engine.onIncomingMessage(incoming)
					} catch (error) {
						log.error(
							`job ${job.id}: incoming message error: ${error instanceof Error ? error.message : String(error)}`,
						)
					}
				}
			},
			onIncomingDm: async (dm) => {
				// Plugin DM hooks are fire-and-forget, non-blocking
				this.pluginManager.emitIncomingDm(dm)
			},
		})

		// Plugin manager — initialized after wa since it references it via deps
		this.pluginManager = new PluginManager({
			sendText: (groupId, text, opts) =>
				this.enqueueOutbound(
					groupId,
					() => this.wa.sendText(groupId, text, opts),
					{ typing: (opts as any)?.typing ?? true },
				),
			sendImageWithCaption: (groupId, imagePath, caption) =>
				this.enqueueOutbound(
					groupId,
					() => this.wa.sendImageWithCaption(groupId, imagePath, caption),
					{ typing: true },
				),
			sendTyping: (groupId) => this.wa.sendTyping(groupId),
			react: (groupId, key, emoji) => this.wa.react(groupId, key, emoji),
			reactDm: (senderJid, key, emoji) => this.wa.reactDm(senderJid, key, emoji),
			sendDmText: (senderJid, text, opts) =>
				this.enqueueOutbound(
					senderJid,
					() => this.wa.sendText(senderJid, text, opts),
					{ typing: true },
				),
			lookupPnByLid: (lid) => this.wa.lookupPnByLid(lid),
			lookupLidByPn: (pn) => this.wa.lookupLidByPn(pn),
			isConnected: () => this.wa.isConnected(),
			getProvider: () => this.wa.provider as WhatsAppProvider,
			getOwnJid: () => this.wa.getOwnJid(),
			isQuizRunning: async (groupId) => this.isQuizRunningForGroup(groupId),
			getSeasonScores: async (groupId) => this.getSeasonScoresForGroup(groupId),
		})
	}

	private finishJob(jobId: string): void {
		const job = this.jobs.get(jobId)
		if (!job) return
		const groupId = job.meta.groupId
		this.removeFromQueue(jobId, groupId)
		this.jobs.delete(jobId)
		this.advanceQueue(groupId)
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
			...(this.eventLogger ? { eventLogger: this.eventLogger } : {}),
		})
	}

	private generateJobId(): string {
		this.jobCounter += 1
		return `q-${Date.now()}-${this.jobCounter}`
	}

	// ---------------------------------------------------------------------------
	// Per-group queue management
	// ---------------------------------------------------------------------------

	/** Get the active (first-in-queue) job ID for a group, or undefined if none. */
	private getActiveJobIdForGroup(groupId: string): string | undefined {
		const queue = this.groupQueues.get(groupId)
		return queue?.[0]
	}

	/** Check whether a job is the active (first-in-queue) job for its group. */
	private isActiveJob(jobId: string, groupId: string): boolean {
		return this.getActiveJobIdForGroup(groupId) === jobId
	}

	/** Check if a quiz is actively running for a given group (past intro, asking questions). */
	private isQuizRunningForGroup(groupId: string): boolean {
		const activeJobId = this.getActiveJobIdForGroup(groupId)
		if (!activeJobId) return false
		const job = this.jobs.get(activeJobId)
		return job?.engine.isActivelyRunning() ?? false
	}

	private async getSeasonScoresForGroup(
		groupId: string,
	): Promise<
		Array<{ mid: string; nickname: string; kananame: string; classgroup: string; score: number; rank: number }>
	> {
		const points = await this.seasonStore.getPointsAsync(groupId)
		const members = await this.seasonStore.getMembersAsync(groupId)
		const reachedAt = await this.seasonStore.getReachedAtAsync(groupId)
		if (points.size === 0) return []

		// Build member lookup
		const memberMap = new Map<string, { mid: string; kananame: string; nickname: string; classgroup: string }>()
		for (const m of members) {
			memberMap.set(m.mid, { mid: m.mid, kananame: m.kananame, nickname: m.nickname, classgroup: m.classgroup })
		}

		// Sort: highest points first, tie-break by earliest reachedAt
		const sorted = [...points.entries()].sort((a, b) => {
			if (b[1] !== a[1]) return b[1] - a[1]
			const aTime = reachedAt.get(a[0]) ?? Infinity
			const bTime = reachedAt.get(b[0]) ?? Infinity
			return aTime - bTime
		})

		return sorted.map(([mid, score], i) => {
			const m = memberMap.get(mid)
			return {
				mid,
				nickname: m?.nickname ?? mid,
				kananame: m?.kananame ?? '-',
				classgroup: m?.classgroup ?? '-',
				score,
				rank: i + 1,
			}
		})
	}

	/**
	 * Add a job ID to its group's queue, sorted by firstRoundAt (earliest first).
	 * Returns the position in the queue (0-based).
	 */
	private addToQueue(jobId: string, groupId: string): number {
		const queue = this.groupQueues.get(groupId) ?? []
		queue.push(jobId)
		queue.sort((a, b) => {
			const jobA = this.jobs.get(a)
			const jobB = this.jobs.get(b)
			const atA = jobA?.meta.firstRoundAt?.getTime() ?? Infinity
			const atB = jobB?.meta.firstRoundAt?.getTime() ?? Infinity
			return atA - atB
		})
		this.groupQueues.set(groupId, queue)
		return queue.indexOf(jobId)
	}

	/** Remove a job ID from its group's queue. Returns the groupId. */
	private removeFromQueue(jobId: string, groupId: string): void {
		const queue = this.groupQueues.get(groupId)
		if (!queue) return
		const idx = queue.indexOf(jobId)
		if (idx >= 0) queue.splice(idx, 1)
		if (queue.length === 0) {
			this.groupQueues.delete(groupId)
		}
	}

	/**
	 * Start the engine for the next job in a group's queue.
	 * Called after a job finishes or is removed.
	 */
	private advanceQueue(groupId: string): void {
		const queue = this.groupQueues.get(groupId)
		if (!queue || queue.length === 0) return

		const nextJobId = queue[0]!
		const nextJob = this.jobs.get(nextJobId)
		if (!nextJob || !nextJob.deferred) return

		const { quizBundle, members, runOptions } = nextJob.deferred
		nextJob.deferred = null // consumed

		log.info(`advancing queue for group ${groupId}: starting job ${nextJobId}`)
		void nextJob.engine
			.run(quizBundle, members, groupId, runOptions)
			.catch((error: unknown) => {
				log.error(`queued job ${nextJobId} runtime failed: ${error instanceof Error ? error.message : String(error)}`)
				this.finishJob(nextJobId)
			})
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

		const entries = [...parsed.jobs].sort((a, b) => {
			const atA = a.firstRoundAt ? new Date(a.firstRoundAt).getTime() : Number.POSITIVE_INFINITY
			const atB = b.firstRoundAt ? new Date(b.firstRoundAt).getTime() : Number.POSITIVE_INFINITY
			if (atA !== atB) return atA - atB
			return a.createdAt.localeCompare(b.createdAt)
		})

		let recovered = 0
		for (const entry of entries) {
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
					deferred: { quizBundle, members, runOptions },
				}
				this.jobs.set(jobId, jobRecord)
				const position = this.addToQueue(jobId, resolvedGroupId)
				if (position === 0) {
					this.advanceQueue(resolvedGroupId)
				}

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
			const queue = this.groupQueues.get(job.meta.groupId) ?? []
			const queuePosition = queue.indexOf(job.id)
			return {
				id: job.id,
				groupId: job.meta.groupId,
				quizDir: job.meta.quizDir,
				...(job.meta.membersFile ? { membersFile: job.meta.membersFile } : {}),
				noCooldown: job.meta.noCooldown,
				...(job.meta.noGeneration ? { noGeneration: true } : {}),
				...(queuePosition >= 0 ? { queuePosition } : {}),
				status,
				introAt: introAt?.toISOString(),
				firstRoundAt: firstRoundAt?.toISOString(),
				createdAt: job.meta.createdAt.toISOString(),
			}
		})
	}

	private async forceEndJob(
		jobId: string,
		opts?: { silent?: boolean },
	): Promise<{ stopped: boolean; silent: boolean }> {
		const job = this.jobs.get(jobId)
		if (!job) return { stopped: false, silent: false }

		const effectiveSilent = __runtimeTestInternals.computeStopSilenceFromStatus(
			job.meta.firstRoundAt,
			Date.now(),
			job.engine.isRunning(),
			opts?.silent,
		)

		if (effectiveSilent) {
			job.engine.stopCurrentQuiz()
		} else {
			await job.engine.stopCurrentQuizWithFinal()
		}
		this.finishJob(jobId)
		return { stopped: true, silent: effectiveSilent }
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

			// Initialize event logger for live spectator view
			try {
				const { QuizEventLogger } = await import('../quiz/event-logger.ts')
				this.eventLogger = new QuizEventLogger()
				await this.eventLogger.init()
			} catch (err) {
				log.warning('failed to initialize event logger, continuing without live logging', { error: err })
			}

			// Initialize plugin manager and restore persisted plugins
			await this.pluginManager.init()
			if (!this.fresh) {
				await this.pluginManager.restoreFromManifest()
			}

			// Emit WA connected event to plugins
			this.pluginManager.emitWaConnected()

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
										`[${job.status}] ${job.id} group=${job.groupId} queue=${
											job.queuePosition ?? '-'
										} quizDir=${job.quizDir} cooldown=${job.noCooldown ? 'off' : 'on'} generation=${
											job.noGeneration ? 'off' : 'on'
										}`,
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
								const silent = parsed.data.silent ?? false
								if (targetId) {
									const result = await this.forceEndJob(targetId, { silent })
									if (!result.stopped) {
										writeResponse(socket, { ok: false, message: `no active job with id "${targetId}"` })
										return
									}
									writeResponse(socket, {
										ok: true,
										message: result.silent
											? `job "${targetId}" stopped silently`
											: `job "${targetId}" stopped with final scoreboard`,
									})
									return
								}
								const allJobs = this.getJobStatus()
								if (allJobs.length === 0) {
									writeResponse(socket, { ok: false, message: 'no active quiz jobs to stop' })
									return
								}
								if (allJobs.length === 1) {
									const jobId = allJobs[0]!.id
									const result = await this.forceEndJob(jobId, { silent })
									writeResponse(socket, {
										ok: true,
										message: result.silent
											? `job "${jobId}" stopped silently`
											: `job "${jobId}" stopped with final scoreboard`,
									})
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

							if (parsed.data.type === 'season-stop') {
								const groupId = parsed.data.groupId
								const allJobs = [...this.jobs.values()].filter(j => j.meta.groupId === groupId)

								// First find a bundle to use for formatting
								let sampleBundle: any = null
								for (const job of allJobs) {
									// stop current jobs WITHOUT sending the final season scoreboard from engine
									// because we will send it here
									const engine = job.engine
									await engine.stopCurrentQuizWithFinal() // This sends quiz scoreboard
									// The engine only sends season scoreboard if bundle.season.end is true.
									// Assuming it is false or we don't care, we'll just send it below.
									if (!sampleBundle) {
										sampleBundle = (engine as any).state?.bundle
									}
									this.finishJob(job.id)
								}
								this.groupQueues.delete(groupId)
								const seasonId = sampleBundle?.season?.id as string | undefined

								if (!parsed.data.noScoreboard) {
									const seasonPoints = await this.seasonStore.getPointsAsync(groupId, seasonId)
									const seasonMembers = await this.seasonStore.getMembersAsync(groupId, seasonId)
									if (seasonPoints.size > 0) {
										const seasonRows = [...seasonPoints.entries()]
											.map(([mid, points]) => ({
												member: sampleBundle?.members?.find((m: any) => m.mid === mid) ?? seasonMembers.find((m) =>
													m.mid === mid
												) ?? null,
												points,
											}))
											.sort((a, b) => {
												if (b.points !== a.points) return b.points - a.points
												return (a.member?.mid ?? '').localeCompare(b.member?.mid ?? '')
											})

										const top3 = seasonRows.slice(0, 3)
										const topSlots = seasonRows.slice(0, 7).map((entry, index) => ({
											rank: index + 1,
											kananame: entry.member?.kananame ?? '',
											nickname: entry.member?.nickname ?? entry.member?.mid ?? '',
											classgroup: entry.member?.classgroup ?? '',
											score: entry.points,
										}))

										try {
											const { generateSeasonScoreboardImage } = await import('../quiz/season-scoreboard.ts')
											const groupIdStem = groupId.split('@')[0] ?? groupId
											const scoreboardOutput = await generateSeasonScoreboardImage(topSlots, {
												...(sampleBundle?.season?.scoreboardTemplate
													? { templatePath: sampleBundle.season.scoreboardTemplate }
													: {}),
												outputStem: `scoreboard-${groupIdStem}`,
											})

											const { formatSeasonTopMessage, formatSeasonOthersMessage } = await import('../quiz/messages.ts')
											const imgCaption = formatSeasonTopMessage(top3, sampleBundle?.season?.caption)
											await this.enqueueOutbound(
												groupId,
												() => this.wa.sendImageWithCaption(groupId, scoreboardOutput.jpgPath, imgCaption),
												{ typing: true },
											)

											const othersMessage = formatSeasonOthersMessage(seasonRows)
											if (othersMessage) {
												await this.enqueueOutbound(
													groupId,
													() => this.wa.sendText(groupId, othersMessage, { linkPreview: false }),
													{ typing: true },
												)
											}
										} catch (error) {
											const { getLogger } = await import('../logger.ts')
											getLogger().warning(
												`season scoreboard image generation failed in daemon: ${
													error instanceof Error ? error.message : String(error)
												}`,
											)
										}
									}
								}

								await this.seasonStore.resetGroup(groupId, seasonId)

								writeResponse(socket, {
									ok: true,
									message: `Season stopped for ${groupId}. ${allJobs.length} active quiz(zes) stopped.`,
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

							if (parsed.data.type === 'plugin-enable') {
								try {
									const args = parsed.data.args ?? {}
									const name = await this.pluginManager.enable(parsed.data.sourcePath, args)
									writeResponse(socket, {
										ok: true,
										message: `plugin "${name}" enabled`,
									})
								} catch (error) {
									writeResponse(socket, {
										ok: false,
										message: `plugin enable failed: ${error instanceof Error ? error.message : String(error)}`,
									})
								}
								return
							}

							if (parsed.data.type === 'plugin-disable') {
								const pluginName = parsed.data.name
								const entry = this.pluginManager.list().find((p) => p.name === pluginName)
								if (!entry) {
									writeResponse(socket, {
										ok: false,
										message: `no plugin named "${pluginName}" found`,
									})
									return
								}
								await this.pluginManager.disable(pluginName)
								writeResponse(socket, {
									ok: true,
									message: `plugin "${pluginName}" disabled`,
								})
								return
							}

							if (parsed.data.type === 'plugin-list') {
								const plugins = this.pluginManager.list()
								if (plugins.length === 0) {
									writeResponse(socket, {
										ok: true,
										message: 'no plugins loaded',
										plugins: [],
									})
									return
								}
								const lines = plugins.map(
									(p) => `[${p.active ? 'active' : 'inactive'}] ${p.name} (${p.sourcePath})`,
								)
								writeResponse(socket, {
									ok: true,
									message: `${plugins.length} plugin(s):\n${lines.join('\n')}`,
									plugins,
								})
								return
							}

							if (parsed.data.type === 'plugin-ask') {
								const askEntry = this.pluginManager.list().find((p) => p.name === 'ask')
								if (!askEntry) {
									writeResponse(socket, { ok: false, message: 'ask plugin not loaded' })
									return
								}
								const activeEntry = this.pluginManager.getActiveEntry('ask')
								if (!activeEntry) {
									writeResponse(socket, { ok: false, message: 'ask plugin not active' })
									return
								}
								const hooks = activeEntry.hooks
								if (parsed.data.action === 'close') {
									const msg = parsed.data.message ?? '⚠️ Lagi dalam pengembangan!'
									hooks.closedMessage = msg
									writeResponse(socket, { ok: true, message: `ask plugin closed: "${msg}"` })
									return
								}
								if (parsed.data.action === 'open') {
									hooks.closedMessage = undefined
									writeResponse(socket, { ok: true, message: 'ask plugin opened' })
									return
								}
								if (parsed.data.action === 'tool') {
									const toolName = parsed.data.tool
									if (!toolName) {
										writeResponse(socket, { ok: false, message: 'tool name required' })
										return
									}
									const tools = hooks.tools
									if (!tools || !(toolName in tools)) {
										const available = tools ? Object.keys(tools).join(', ') : 'none'
										writeResponse(socket, {
											ok: false,
											message: `tool "${toolName}" not found. Available: ${available}`,
										})
										return
									}
									try {
										const toolFn = tools?.[toolName]
										if (!toolFn) {
											writeResponse(socket, { ok: false, message: `tool "${toolName}" not callable` })
											return
										}
										const result = await toolFn(parsed.data.toolArgs ?? [])
										writeResponse(socket, { ok: true, message: result, data: result })
									} catch (err) {
										writeResponse(socket, {
											ok: false,
											message: `tool error: ${err instanceof Error ? err.message : String(err)}`,
										})
									}
									return
								}
								writeResponse(socket, { ok: false, message: `unknown action: ${parsed.data.action}` })
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
								deferred: { quizBundle, members, runOptions },
							}
							this.jobs.set(jobId, jobRecord)
							const queuePosition = this.addToQueue(jobId, resolvedGroupId)
							if (queuePosition === 0) {
								this.advanceQueue(resolvedGroupId)
							}
							void this.persistState().catch(() => undefined)

							if (parsed.data.noSchedule) {
								writeResponse(socket, {
									ok: true,
									message: queuePosition === 0
										? `quiz queued and running immediately (${jobId}) (--no-schedule)`
										: `quiz queued (${jobId}) at position ${queuePosition + 1} (--no-schedule)`,
									jobId,
								})
							} else {
								writeResponse(socket, {
									ok: true,
									message: `quiz queued (${jobId}) pos=${queuePosition + 1} (intro ${
										formatWibDateTime(quizBundle.introAt)
									} WIB; in ${formatDelay(introDelayMs)} | round1 ${formatWibDateTime(firstRoundAt)} WIB; in ${
										formatDelay(startDelayMs)
									})`,
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
			await this.pluginManager.shutdown()
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
