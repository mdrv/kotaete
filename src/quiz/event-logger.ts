import { RecordId, Surreal } from 'surrealdb'
import { getLogger } from '../logger.ts'
import { getConnectionStatus, getDb } from '../utils/surreal.ts'

/** Parse a session ID string ('quiz_session:xxx' or plain 'xxx') into a RecordId. */
function parseSessionRecordId(sessionId: string): RecordId {
	const idx = sessionId.indexOf(':')
	if (idx >= 0) {
		return new RecordId(sessionId.slice(0, idx), sessionId.slice(idx + 1))
	}
	return new RecordId('quiz_session', sessionId)
}

/** Ensure a sessionId value is a RecordId for SurrealDB queries. */
function toRid(sessionId: string | RecordId): RecordId {
	if (sessionId instanceof RecordId) return sessionId
	return parseSessionRecordId(sessionId)
}

export interface QuizEventLoggerOptions {
	endpoint?: string
	username?: string
	password?: string
	namespace?: string
	database?: string
}

const SCHEMA_QUERIES = [
	// Quiz session (mutable state projection)
	`DEFINE TABLE OVERWRITE quiz_session SCHEMAFULL`,
	`DEFINE FIELD OVERWRITE group_id ON quiz_session TYPE string`,
	`DEFINE FIELD OVERWRITE season_id ON quiz_session TYPE option<string>`,
	`DEFINE FIELD OVERWRITE job_id ON quiz_session TYPE string`,
	`DEFINE FIELD OVERWRITE status ON quiz_session TYPE string DEFAULT 'running'`,
	`DEFINE FIELD OVERWRITE started_at ON quiz_session TYPE datetime`,
	`DEFINE FIELD OVERWRITE finished_at ON quiz_session TYPE option<datetime>`,
	`DEFINE FIELD OVERWRITE total_questions ON quiz_session TYPE number`,
	`DEFINE FIELD OVERWRITE current_question ON quiz_session TYPE option<number>`,
	`DEFINE FIELD OVERWRITE current_round ON quiz_session TYPE option<number>`,
	`DEFINE FIELD OVERWRITE accepting_answers ON quiz_session TYPE bool DEFAULT false`,
	`DEFINE FIELD OVERWRITE deadline_at ON quiz_session TYPE option<datetime>`,
	`DEFINE FIELD OVERWRITE quiz_dir ON quiz_session TYPE option<string>`,
	`DEFINE INDEX OVERWRITE idx_quiz_session_group ON quiz_session COLUMNS group_id`,
	`DEFINE INDEX OVERWRITE idx_quiz_session_active ON quiz_session COLUMNS group_id, status`,

	// Quiz events (append-only log)
	`DEFINE TABLE OVERWRITE quiz_event SCHEMAFULL`,
	`DEFINE FIELD OVERWRITE session_id ON quiz_event TYPE record<quiz_session>`,
	`DEFINE FIELD OVERWRITE group_id ON quiz_event TYPE string`,
	`DEFINE FIELD OVERWRITE season_id ON quiz_event TYPE option<string>`,
	`DEFINE FIELD OVERWRITE event_type ON quiz_event TYPE string`,
	`DEFINE FIELD OVERWRITE question_no ON quiz_event TYPE option<number>`,
	`DEFINE FIELD OVERWRITE member_mid ON quiz_event TYPE option<string>`,
	`DEFINE FIELD OVERWRITE member_kananame ON quiz_event TYPE option<string>`,
	`DEFINE FIELD OVERWRITE member_nickname ON quiz_event TYPE option<string>`,
	`DEFINE FIELD OVERWRITE member_classgroup ON quiz_event TYPE option<string>`,
	`DEFINE FIELD OVERWRITE data ON quiz_event TYPE option<object> FLEXIBLE`,
	`DEFINE FIELD OVERWRITE created_at ON quiz_event TYPE datetime DEFAULT time::now()`,
	`DEFINE INDEX OVERWRITE idx_quiz_event_session ON quiz_event COLUMNS session_id`,
	`DEFINE INDEX OVERWRITE idx_quiz_event_session_type ON quiz_event COLUMNS session_id, event_type`,

	// Live scoreboard (per-member, mutable)
	`DEFINE TABLE OVERWRITE live_score SCHEMAFULL`,
	`DEFINE FIELD OVERWRITE session_id ON live_score TYPE record<quiz_session>`,
	`DEFINE FIELD OVERWRITE member_mid ON live_score TYPE string`,
	`DEFINE FIELD OVERWRITE member_kananame ON live_score TYPE string`,
	`DEFINE FIELD OVERWRITE member_nickname ON live_score TYPE string`,
	`DEFINE FIELD OVERWRITE member_classgroup ON live_score TYPE string`,
	`DEFINE FIELD OVERWRITE points ON live_score TYPE number DEFAULT 0`,
	`DEFINE FIELD OVERWRITE reached_at ON live_score TYPE option<datetime>`,
	`DEFINE INDEX OVERWRITE idx_live_score_session ON live_score COLUMNS session_id`,
	`DEFINE INDEX OVERWRITE idx_live_score_member ON live_score COLUMNS session_id, member_mid UNIQUE`,

	// Live member state (cooldown, wrong attempts — per-member transient state)
	`DEFINE TABLE OVERWRITE live_member_state SCHEMAFULL`,
	`DEFINE FIELD OVERWRITE session_id ON live_member_state TYPE record<quiz_session>`,
	`DEFINE FIELD OVERWRITE member_mid ON live_member_state TYPE string`,
	`DEFINE FIELD OVERWRITE member_kananame ON live_member_state TYPE string`,
	`DEFINE FIELD OVERWRITE member_nickname ON live_member_state TYPE string`,
	`DEFINE FIELD OVERWRITE cooldown_until ON live_member_state TYPE option<datetime>`,
	`DEFINE FIELD OVERWRITE wrong_remaining ON live_member_state TYPE option<number>`,
	`DEFINE INDEX OVERWRITE idx_lms_session ON live_member_state COLUMNS session_id`,
	`DEFINE INDEX OVERWRITE idx_lms_member ON live_member_state COLUMNS session_id, member_mid UNIQUE`,
] as const

export class QuizEventLogger {
	private db: Surreal | null = null
	private readonly options: QuizEventLoggerOptions
	private queryChain = Promise.resolve()
	private _sessionId: RecordId | null = null
	private readonly log = getLogger(['kotaete', 'event-logger'])

	constructor(options?: QuizEventLoggerOptions) {
		this.options = options ?? {}
	}

	private ensureDb(): Surreal {
		if (!this.db) throw new Error('QuizEventLogger not initialized — call init() first')
		return this.db
	}

	private static readonly RETRY_DELAYS = [500, 1_000, 2_000, 5_000]

	private chain(fn: () => Promise<void>, label?: string): Promise<void> {
		this.log.debug(`chain: queuing ${label ?? 'unknown'} [dbStatus=${getConnectionStatus() ?? 'n/a'}]`)
		const run = async () => {
			const dbStatus = getConnectionStatus() ?? 'n/a'
			this.log.debug(`chain: executing ${label ?? 'unknown'} [dbStatus=${dbStatus}]`)

			for (let attempt = 0; attempt <= QuizEventLogger.RETRY_DELAYS.length; attempt++) {
				try {
					await fn()
					this.log.debug(`chain: completed ${label ?? 'unknown'} [attempt=${attempt + 1}]`)
					return
				} catch (err) {
					const isLastAttempt = attempt >= QuizEventLogger.RETRY_DELAYS.length
					const errMsg = err instanceof Error ? err.message : String(err)
					const errName = err instanceof Error ? err.constructor.name : 'UnknownError'

					if (isLastAttempt) {
						this.log.error(
							`chain: FAILED after ${attempt + 1} attempts: ${
								label ?? 'unknown'
							}: [${errName}] ${errMsg} [dbStatus=${dbStatus}]`,
						)
						return // don't throw — keep chain alive
					}

					const delay = QuizEventLogger.RETRY_DELAYS[attempt]
					this.log.warning(
						`chain: retry ${label ?? 'unknown'} in ${delay}ms (attempt ${
							attempt + 1
						}) [${errName}] ${errMsg} [dbStatus=${dbStatus}]`,
					)
					await new Promise((resolve) => setTimeout(resolve, delay))
				}
			}
		}
		this.queryChain = this.queryChain.then(run, run)
		return this.queryChain
	}

	async init(): Promise<void> {
		const db = await getDb(this.options)
		this.log.info('event-logger initialized', { dbStatus: db.status })

		for (const q of SCHEMA_QUERIES) {
			await db.query(q)
		}

		// Migration: remove old member_name field (replaced by member_kananame + member_nickname)
		for (const table of ['quiz_event', 'live_score', 'live_member_state']) {
			try {
				await db.query(`REMOVE FIELD IF EXISTS member_name ON ${table}`)
			} catch {
				// Field may already be removed — ignore
			}
		}

		this.db = db
	}

	async close(): Promise<void> {
		const sid = this._sessionId
		this._sessionId = null
		this.db = null
		if (sid) this.log.debug('closed event logger for session {sessionId}', { sessionId: sid })
	}

	// ── Session lifecycle ──

	async createSession(opts: {
		groupId: string
		seasonId?: string
		jobId: string
		totalQuestions: number
		quizDir?: string
	}): Promise<string> {
		const db = this.ensureDb()
		const result = await db.query<[{ id: string }[]]>(
			`CREATE quiz_session SET group_id = $gid, season_id = $sid, job_id = $jid, total_questions = $tq, quiz_dir = $qdir ?? NONE, started_at = time::now(), status = 'running'`,
			{
				gid: opts.groupId,
				sid: opts.seasonId ?? undefined,
				jid: opts.jobId,
				tq: opts.totalQuestions,
				qdir: opts.quizDir ?? undefined,
			},
		)
		const rawId = result[0]?.[0]?.id
		if (!rawId) throw new Error('Failed to create quiz_session — no ID returned')
		this._sessionId = parseSessionRecordId(String(rawId))
		return String(this._sessionId)
	}
	/** Reuse an existing quiz session (e.g. after daemon restart). Restores status to 'running' and stores the ID. */
	reactivateSession(sessionId: string): void {
		const rid = parseSessionRecordId(sessionId)
		this._sessionId = rid
		this.chain(async () => {
			const db = this.ensureDb()
			await db.query(
				`UPDATE $sid SET status = 'running', finished_at = NONE WHERE status = 'crashed'`,
				{ sid: rid },
			)
		}, 'reactivateSession')
	}

	updateSessionState(sessionId: string, opts: {
		currentQuestion?: number
		currentRound?: number
		acceptingAnswers?: boolean
		deadlineAt?: Date | null
	}): void {
		this.log.debug(
			`updateSessionState: sid=${sessionId} q=${opts?.currentQuestion} r=${opts?.currentRound} accept=${opts?.acceptingAnswers} dl=${
				opts?.deadlineAt ?? 'none'
			}`,
		)
		this.chain(async () => {
			const db = this.ensureDb()
			const sets: string[] = []
			if (opts.currentQuestion !== undefined) sets.push(`current_question: ${opts.currentQuestion}`)
			if (opts.currentRound !== undefined) sets.push(`current_round: ${opts.currentRound}`)
			if (opts.acceptingAnswers !== undefined) sets.push(`accepting_answers: ${opts.acceptingAnswers}`)
			if (opts.deadlineAt !== undefined) {
				if (opts.deadlineAt === null) {
					sets.push(`deadline_at: NONE`)
				} else {
					sets.push(`deadline_at: <datetime>'${opts.deadlineAt.toISOString()}'`)
				}
			}
			if (sets.length === 0) return
			const query = `UPDATE $sid MERGE { ${sets.join(', ')} }`
			this.log.debug(`updateSessionState: sets=[${sets.join(', ')}] sidRid=${String(toRid(sessionId))}`)
			await db.query(
				query,
				{ sid: toRid(sessionId) },
			)
		}, 'updateSessionState')
	}

	finishSession(sessionId: string, status?: string): void {
		const finishStatus = status ?? 'finished'
		this.log.debug(`finishSession: sid=${sessionId} status=${finishStatus}`)
		this.chain(async () => {
			const db = this.ensureDb()
			await db.query(
				`UPDATE $sid SET status = $status, finished_at = time::now()`,
				{ sid: toRid(sessionId), status: finishStatus },
			)
		}, 'finishSession')
	}
	cleanupStaleSessions(): Promise<void> {
		return this.chain(async () => {
			const db = this.ensureDb()
			// Mark orphaned running sessions as crashed
			const [stale] = await db.query<[{}[]]>(
				`UPDATE quiz_session SET status = 'crashed', finished_at = time::now() WHERE status = 'running'`,
			)
			const count = stale?.length ?? 0
			if (count > 0) {
				this.log.info('cleaned up {count} stale quiz_session(s)', { count })
			}
		}, 'cleanupStaleSessions')
	}

	// ── Events ──

	logEvent(sessionId: string, opts: {
		groupId: string
		seasonId?: string
		eventType: string
		questionNo?: number
		memberMid?: string
		memberKananame?: string
		memberNickname?: string
		memberClassgroup?: string
		data?: Record<string, unknown>
	}): void {
		this.chain(async () => {
			const db = this.ensureDb()
			await db.query(
				`CREATE quiz_event SET session_id = $sid, group_id = $gid, season_id = $season_id ?? NONE, event_type = $etype, question_no = $qno ?? NONE, member_mid = $mmid ?? NONE, member_kananame = $mkana ?? NONE, member_nickname = $mnick ?? NONE, member_classgroup = $mcg ?? NONE, data = $data ?? NONE`,
				{
					sid: toRid(sessionId),
					gid: opts.groupId,
					season_id: opts.seasonId ?? null,
					etype: opts.eventType,
					qno: opts.questionNo ?? null,
					mmid: opts.memberMid ?? null,
					mkana: opts.memberKananame ?? null,
					mnick: opts.memberNickname ?? null,
					mcg: opts.memberClassgroup ?? null,
					data: opts.data ?? null,
				},
			)
		}, `logEvent:${opts.eventType}`)
	}

	// ── Live score ──

	upsertLiveScore(sessionId: string, member: {
		mid: string
		kananame: string
		nickname: string
		classgroup: string
	}, points: number): void {
		this.chain(async () => {
			const db = this.ensureDb()
			const reachedExpr = points > 0 ? `reached_at = time::now()` : `reached_at = $existing[0].reached_at`
			await db.query(
				`LET $existing = (SELECT points, reached_at FROM live_score WHERE session_id = $sid AND member_mid = $mid LIMIT 1);
				IF $existing = [] {
					CREATE live_score SET session_id = $sid, member_mid = $mid, points = $points, reached_at = <datetime>${
					points > 0 ? 'time::now()' : 'NONE'
				}, member_kananame = $kananame, member_nickname = $nickname, member_classgroup = $classgroup;
				} ELSE {
					UPDATE live_score SET points = $points, ${reachedExpr}, member_kananame = $kananame, member_nickname = $nickname, member_classgroup = $classgroup WHERE session_id = $sid AND member_mid = $mid;
				}`,
				{
					sid: toRid(sessionId),
					mid: member.mid,
					points,
					kananame: member.kananame,
					nickname: member.nickname,
					classgroup: member.classgroup,
				},
			)
		}, 'upsertLiveScore')
	}

	deleteLiveScores(sessionId: string): void {
		this.chain(async () => {
			const db = this.ensureDb()
			await db.query(
				`DELETE FROM live_score WHERE session_id = $sid`,
				{ sid: toRid(sessionId) },
			)
		}, 'deleteLiveScores')
	}

	// ── Live member state ──

	upsertMemberState(sessionId: string, member: {
		mid: string
		kananame: string
		nickname: string
		classgroup: string
	}, opts: {
		cooldownUntil?: Date | null
		wrongRemaining?: number
	}): void {
		this.chain(async () => {
			const db = this.ensureDb()
			const updateCd = opts.cooldownUntil !== undefined
			const cdVal = opts.cooldownUntil ? `<datetime>'${opts.cooldownUntil.toISOString()}'` : 'NONE'
			const cdFragment = updateCd ? `, cooldown_until = ${cdVal}` : ''
			await db.query(
				`LET $existing = (SELECT id FROM live_member_state WHERE session_id = $sid AND member_mid = $mid LIMIT 1);
				IF $existing = [] {
					CREATE live_member_state SET session_id = $sid, member_mid = $mid, member_kananame = $kananame, member_nickname = $nickname${cdFragment}, wrong_remaining = $wr;
				} ELSE {
					UPDATE live_member_state SET member_kananame = $kananame, member_nickname = $nickname${cdFragment}, wrong_remaining = $wr WHERE session_id = $sid AND member_mid = $mid;
				}`,
				{
					sid: toRid(sessionId),
					mid: member.mid,
					kananame: member.kananame,
					nickname: member.nickname,
					wr: opts.wrongRemaining ?? undefined,
				},
			)
		}, 'upsertMemberState')
	}

	deleteMemberStates(sessionId: string): void {
		this.chain(async () => {
			const db = this.ensureDb()
			await db.query(
				`DELETE FROM live_member_state WHERE session_id = $sid`,
				{ sid: toRid(sessionId) },
			)
		}, 'deleteMemberStates')
	}
}
