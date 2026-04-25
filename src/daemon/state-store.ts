import { Surreal } from 'surrealdb'
import type { QuizStateCheckpoint } from '../quiz/checkpoint.ts'
import { quizStateCheckpointSchema } from '../quiz/checkpoint.ts'
import type { SurrealOptions } from '../utils/surreal.ts'
import { getDb } from '../utils/surreal.ts'
import { getLogger } from '../logger.ts'

export type DaemonJobStatus = 'queued' | 'running' | 'finishing' | 'done'

export type DaemonJobState = {
	jobId: string
	sources: string[]
	groupId: string
	quizDir: string
	membersFile: string | null
	noCooldown: boolean
	noSchedule: boolean
	noGeneration: boolean
	createdAt: string
	introAt: string | null
	firstRoundAt: string | null
	status: DaemonJobStatus
	lastHeartbeatAt: string | null
}

type DaemonJobRow = {
	job_id: string
	sources?: string[]
	group_id: string
	quiz_dir: string
	members_file?: string | null
	no_cooldown: boolean
	no_schedule: boolean
	no_generation?: boolean
	created_at: string | Date
	intro_at?: string | Date | null
	first_round_at?: string | Date | null
	status?: string
	last_heartbeat_at?: string | Date | null
}

type DaemonCheckpointRow = {
	checkpoint: QuizStateCheckpoint
}

const SCHEMA_QUERIES = [
	`DEFINE TABLE OVERWRITE daemon_job SCHEMAFULL`,
	`DEFINE FIELD OVERWRITE job_id ON daemon_job TYPE string`,
	`DEFINE FIELD OVERWRITE sources ON daemon_job TYPE array<string>`,
	`DEFINE FIELD OVERWRITE group_id ON daemon_job TYPE string`,
	`DEFINE FIELD OVERWRITE quiz_dir ON daemon_job TYPE string`,
	`DEFINE FIELD OVERWRITE members_file ON daemon_job TYPE option<string>`,
	`DEFINE FIELD OVERWRITE no_cooldown ON daemon_job TYPE bool DEFAULT false`,
	`DEFINE FIELD OVERWRITE no_schedule ON daemon_job TYPE bool DEFAULT false`,
	`DEFINE FIELD OVERWRITE no_generation ON daemon_job TYPE bool DEFAULT false`,
	`DEFINE FIELD OVERWRITE created_at ON daemon_job TYPE datetime`,
	`DEFINE FIELD OVERWRITE intro_at ON daemon_job TYPE option<datetime>`,
	`DEFINE FIELD OVERWRITE first_round_at ON daemon_job TYPE option<datetime>`,
	`DEFINE FIELD OVERWRITE status ON daemon_job TYPE string DEFAULT 'queued'`,
	`DEFINE FIELD OVERWRITE last_heartbeat_at ON daemon_job TYPE option<datetime>`,
	`DEFINE INDEX OVERWRITE daemon_job_id_unique ON daemon_job COLUMNS job_id UNIQUE`,
	`DEFINE INDEX OVERWRITE daemon_job_id_unique ON daemon_job COLUMNS job_id UNIQUE`,
	`DEFINE TABLE OVERWRITE daemon_checkpoint SCHEMAFULL`,
	`DEFINE TABLE OVERWRITE daemon_checkpoint SCHEMAFULL`,
	`DEFINE FIELD OVERWRITE job_id ON daemon_checkpoint TYPE string`,
	`DEFINE FIELD OVERWRITE rev ON daemon_checkpoint TYPE number DEFAULT 0`,
	`DEFINE FIELD OVERWRITE source ON daemon_checkpoint TYPE string DEFAULT 'resume'`,
	`DEFINE FIELD OVERWRITE checkpoint ON daemon_checkpoint TYPE object FLEXIBLE`,
	`DEFINE FIELD OVERWRITE updated_at ON daemon_checkpoint TYPE datetime DEFAULT time::now()`,
	`DEFINE INDEX OVERWRITE daemon_checkpoint_job_id_unique ON daemon_checkpoint COLUMNS job_id UNIQUE`,

	// Daemon status singleton (heartbeat)
	`DEFINE TABLE OVERWRITE daemon_status SCHEMAFULL`,
	`DEFINE FIELD OVERWRITE status ON daemon_status TYPE string DEFAULT 'starting'`,
	`DEFINE FIELD OVERWRITE last_heartbeat_at ON daemon_status TYPE option<datetime>`,
	`DEFINE FIELD OVERWRITE started_at ON daemon_status TYPE datetime DEFAULT time::now()`,
	`DEFINE FIELD OVERWRITE pid ON daemon_status TYPE number`,
] as const

export type ConsistencyIssue = {
	type: 'orphaned_checkpoint' | 'mid_question_checkpoint'
	jobId: string
	description: string
}

export class DaemonStateStore {
	private db: Surreal | null = null
	private readonly options: SurrealOptions
	private queryChain = Promise.resolve()

	constructor(options?: SurrealOptions) {
		this.options = options ?? {}
	}

	private ensureDb(): Surreal {
		if (!this.db) throw new Error('DaemonStateStore not initialized')
		return this.db
	}

	private chain(fn: () => Promise<void>): Promise<void> {
		const run = async () => {
			await fn()
		}
		this.queryChain = this.queryChain.then(run, run)
		return this.queryChain
	}

	async init(): Promise<void> {
		const db = await getDb(this.options)
		for (const q of SCHEMA_QUERIES) {
			await db.query(q)
		}
		this.db = db
	}

	async clearAll(): Promise<void> {
		const db = this.ensureDb()
		await this.chain(async () => {
			await db.query(`DELETE FROM daemon_checkpoint`)
			await db.query(`DELETE FROM daemon_job`)
		})
	}

	/**
	 * Validate consistency between daemon_job and daemon_checkpoint tables.
	 * Returns issues found (empty array = clean).
	 */
	async validateConsistency(): Promise<ConsistencyIssue[]> {
		const db = this.ensureDb()
		const issues: ConsistencyIssue[] = []

		const jobResult = await db.query<[DaemonJobRow[]]>(`SELECT job_id FROM daemon_job`)
		const checkpointResult = await db.query<[{ job_id: string; checkpoint: { acceptingAnswers?: boolean } }[]]>(
			`SELECT job_id, checkpoint FROM daemon_checkpoint`,
		)

		const jobIds = new Set((jobResult[0] ?? []).map((r) => r.job_id))
		const checkpoints = checkpointResult[0] ?? []

		// Orphaned checkpoints — clean up automatically
		const orphanIds: string[] = []
		for (const cp of checkpoints) {
			if (!jobIds.has(cp.job_id)) {
				issues.push({
					type: 'orphaned_checkpoint',
					jobId: cp.job_id,
					description: `Checkpoint exists for job ${cp.job_id} but no matching daemon_job row — cleaning up`,
				})
				orphanIds.push(cp.job_id)
			}
		}
		if (orphanIds.length > 0) {
			await db.query(`DELETE FROM daemon_checkpoint WHERE job_id IN $ids`, { ids: orphanIds })
		}

		// Mid-question checkpoints that may be stale
		for (const cp of checkpoints) {
			if (cp.checkpoint?.acceptingAnswers === true) {
				issues.push({
					type: 'mid_question_checkpoint',
					jobId: cp.job_id,
					description:
						`Job ${cp.job_id} has checkpoint with acceptingAnswers=true (may need time-bound verification on recovery)`,
				})
			}
		}

		return issues
	}

	async listJobs(): Promise<DaemonJobState[]> {
		const db = this.ensureDb()
		const result = await db.query<[DaemonJobRow[]]>(
			`SELECT job_id, sources, group_id, quiz_dir, members_file, no_cooldown, no_schedule, no_generation, created_at, intro_at, first_round_at, status, last_heartbeat_at
			 FROM daemon_job
			 ORDER BY first_round_at ASC, created_at ASC`,
		)
		return (result[0] ?? []).map((row) => ({
			jobId: row.job_id,
			sources: row.sources ?? [row.quiz_dir],
			groupId: row.group_id,
			quizDir: row.quiz_dir,
			membersFile: row.members_file ?? null,
			noCooldown: row.no_cooldown,
			noSchedule: row.no_schedule,
			noGeneration: row.no_generation ?? false,
			createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
			introAt: row.intro_at
				? (row.intro_at instanceof Date ? row.intro_at.toISOString() : String(row.intro_at))
				: null,
			firstRoundAt: row.first_round_at
				? (row.first_round_at instanceof Date ? row.first_round_at.toISOString() : String(row.first_round_at))
				: null,
			status: (row.status as DaemonJobStatus) ?? 'queued',
			lastHeartbeatAt: row.last_heartbeat_at
				? (row.last_heartbeat_at instanceof Date ? row.last_heartbeat_at.toISOString() : String(row.last_heartbeat_at))
				: null,
		}))
	}

	async syncJobs(jobs: ReadonlyArray<DaemonJobState>): Promise<void> {
		const db = this.ensureDb()
		await this.chain(async () => {
			for (const job of jobs) {
				const createdAt = new Date(job.createdAt)
				const introAt = job.introAt ? new Date(job.introAt) : null
				const firstRoundAt = job.firstRoundAt ? new Date(job.firstRoundAt) : null
				const membersFile = job.membersFile
				await db.query(
					`LET $existing = (SELECT id FROM daemon_job WHERE job_id = $jobId LIMIT 1);
					IF $existing = [] {
						CREATE daemon_job SET
							job_id = $jobId,
							sources = $sources,
							group_id = $groupId,
							quiz_dir = $quizDir,
							no_cooldown = $noCooldown,
							no_schedule = $noSchedule,
							no_generation = $noGeneration,
							created_at = $createdAt,
							intro_at = $introAt,
							first_round_at = $firstRoundAt;
					} ELSE {
						UPDATE daemon_job SET
							sources = $sources,
							group_id = $groupId,
							quiz_dir = $quizDir,
							no_cooldown = $noCooldown,
							no_schedule = $noSchedule,
							no_generation = $noGeneration,
							created_at = $createdAt,
							intro_at = $introAt,
							first_round_at = $firstRoundAt
						WHERE job_id = $jobId;
					}`,
					{
						jobId: job.jobId,
						sources: job.sources,
						groupId: job.groupId,
						quizDir: job.quizDir,
						noCooldown: job.noCooldown,
						noSchedule: job.noSchedule,
						noGeneration: job.noGeneration,
						createdAt,
						introAt,
						firstRoundAt,
					},
				)

				if (membersFile === null) {
					await db.query(`UPDATE daemon_job UNSET members_file WHERE job_id = $jobId`, {
						jobId: job.jobId,
					})
				} else {
					await db.query(`UPDATE daemon_job SET members_file = $membersFile WHERE job_id = $jobId`, {
						jobId: job.jobId,
						membersFile,
					})
				}
			}

			const currentIds = jobs.map((j) => j.jobId)
			await db.query(`DELETE FROM daemon_job WHERE array::len($currentIds) > 0 AND !(job_id IN $currentIds)`, {
				currentIds,
			})
			if (currentIds.length === 0) {
				await db.query(`DELETE FROM daemon_job`)
			}
		})
	}

	async saveCheckpoint(jobId: string, checkpoint: QuizStateCheckpoint): Promise<void> {
		const db = this.ensureDb()
		await this.chain(async () => {
			await db.query(
				`LET $existing = (SELECT id, rev FROM daemon_checkpoint WHERE job_id = $jobId LIMIT 1);
				IF $existing = [] {
					CREATE daemon_checkpoint SET job_id = $jobId, rev = $rev, source = $source, checkpoint = $checkpoint, updated_at = time::now();
				} ELSE IF $existing[0].rev < $rev {
					UPDATE daemon_checkpoint SET rev = $rev, source = $source, checkpoint = $checkpoint, updated_at = time::now() WHERE job_id = $jobId;
				};`,
				{ jobId, rev: checkpoint.rev, source: checkpoint.source, checkpoint },
			)
		})
	}

	async loadCheckpoint(jobId: string): Promise<QuizStateCheckpoint | null> {
		const db = this.ensureDb()
		const result = await db.query<[DaemonCheckpointRow[]]>(
			`SELECT checkpoint FROM daemon_checkpoint WHERE job_id = $jobId LIMIT 1`,
			{ jobId },
		)
		const row = result[0]?.[0]
		if (!row?.checkpoint) return null
		return quizStateCheckpointSchema.parse(row.checkpoint)
	}

	async deleteCheckpoint(jobId: string): Promise<void> {
		const db = this.ensureDb()
		await this.chain(async () => {
			await db.query(`DELETE FROM daemon_checkpoint WHERE job_id = $jobId`, { jobId })
		})
	}

	async updateJobStatus(jobId: string, status: DaemonJobStatus): Promise<void> {
		const db = this.ensureDb()
		await this.chain(async () => {
			await db.query(
				`UPDATE daemon_job SET status = $status, last_heartbeat_at = time::now() WHERE job_id = $jobId`,
				{ jobId, status },
			)
		})
	}

	// ── Daemon status heartbeat ──
	private static readonly STATUS_LOG = getLogger(['kotaete', 'state-store', 'daemon-status'])

	async updateDaemonStatus(status: string): Promise<void> {
		const db = this.ensureDb()
		try {
			await db.query(
				`UPSERT daemon_status:only SET status = $status, last_heartbeat_at = time::now(), pid = $pid, started_at = started_at ?? time::now()`,
				{ status, pid: process.pid },
			)
			DaemonStateStore.STATUS_LOG.debug`heartbeat written: status=${status}`
		} catch (err) {
			DaemonStateStore.STATUS_LOG.error`heartbeat FAILED: ${err}`
		}
	}

	async markDaemonStopped(): Promise<void> {
		const db = this.ensureDb()
		try {
			await db.query(
				`UPSERT daemon_status:only SET status = 'stopped', last_heartbeat_at = time::now()`
			)
		} catch (err) {
			DaemonStateStore.STATUS_LOG.error`markDaemonStopped FAILED: ${err}`
		}
	}
}
