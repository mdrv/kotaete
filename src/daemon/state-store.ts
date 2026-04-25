import { Surreal } from 'surrealdb'
import type { QuizStateCheckpoint } from '../quiz/checkpoint.ts'
import { quizStateCheckpointSchema } from '../quiz/checkpoint.ts'
import type { SurrealOptions } from '../utils/surreal.ts'
import { getDb } from '../utils/surreal.ts'

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
	`DEFINE INDEX OVERWRITE daemon_job_id_unique ON daemon_job COLUMNS job_id UNIQUE`,
	`DEFINE TABLE OVERWRITE daemon_checkpoint SCHEMAFULL`,
	`DEFINE FIELD OVERWRITE job_id ON daemon_checkpoint TYPE string`,
	`DEFINE FIELD OVERWRITE checkpoint ON daemon_checkpoint TYPE object FLEXIBLE`,
	`DEFINE FIELD OVERWRITE updated_at ON daemon_checkpoint TYPE datetime DEFAULT time::now()`,
	`DEFINE INDEX OVERWRITE daemon_checkpoint_job_id_unique ON daemon_checkpoint COLUMNS job_id UNIQUE`,
] as const

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

	async listJobs(): Promise<DaemonJobState[]> {
		const db = this.ensureDb()
		const result = await db.query<[DaemonJobRow[]]>(
			`SELECT job_id, sources, group_id, quiz_dir, members_file, no_cooldown, no_schedule, no_generation, created_at, intro_at, first_round_at
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
				`LET $existing = (SELECT id FROM daemon_checkpoint WHERE job_id = $jobId LIMIT 1);
				IF $existing = [] {
					CREATE daemon_checkpoint SET job_id = $jobId, checkpoint = $checkpoint, updated_at = time::now();
				} ELSE {
					UPDATE daemon_checkpoint SET checkpoint = $checkpoint, updated_at = time::now() WHERE job_id = $jobId;
				}`,
				{ jobId, checkpoint },
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
}
