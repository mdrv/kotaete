import { Surreal } from 'surrealdb'
import { getLogger } from '../logger.ts'

export interface QuizEventLoggerOptions {
	endpoint?: string
	username?: string
	password?: string
	namespace?: string
	database?: string
}

const DEFAULTS = {
	endpoint: 'http://localhost:596/rpc',
	username: 'ua',
	password: 'japan8',
	namespace: 'medrivia',
	database: 'nipbang_kotaete',
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
	`DEFINE FIELD OVERWRITE member_name ON quiz_event TYPE option<string>`,
	`DEFINE FIELD OVERWRITE member_classgroup ON quiz_event TYPE option<string>`,
	`DEFINE FIELD OVERWRITE data ON quiz_event TYPE object FLEXIBLE`,
	`DEFINE FIELD OVERWRITE created_at ON quiz_event TYPE datetime DEFAULT time::now()`,
	`DEFINE INDEX OVERWRITE idx_quiz_event_session ON quiz_event COLUMNS session_id`,
	`DEFINE INDEX OVERWRITE idx_quiz_event_session_type ON quiz_event COLUMNS session_id, event_type`,

	// Live scoreboard (per-member, mutable)
	`DEFINE TABLE OVERWRITE live_score SCHEMAFULL`,
	`DEFINE FIELD OVERWRITE session_id ON live_score TYPE record<quiz_session>`,
	`DEFINE FIELD OVERWRITE member_mid ON live_score TYPE string`,
	`DEFINE FIELD OVERWRITE member_name ON live_score TYPE string`,
	`DEFINE FIELD OVERWRITE member_classgroup ON live_score TYPE string`,
	`DEFINE FIELD OVERWRITE points ON live_score TYPE number DEFAULT 0`,
	`DEFINE FIELD OVERWRITE reached_at ON live_score TYPE option<datetime>`,
	`DEFINE INDEX OVERWRITE idx_live_score_session ON live_score COLUMNS session_id`,
	`DEFINE INDEX OVERWRITE idx_live_score_member ON live_score COLUMNS session_id, member_mid UNIQUE`,

	// Live member state (cooldown, wrong attempts — per-member transient state)
	`DEFINE TABLE OVERWRITE live_member_state SCHEMAFULL`,
	`DEFINE FIELD OVERWRITE session_id ON live_member_state TYPE record<quiz_session>`,
	`DEFINE FIELD OVERWRITE member_mid ON live_member_state TYPE string`,
	`DEFINE FIELD OVERWRITE member_name ON live_member_state TYPE string`,
	`DEFINE FIELD OVERWRITE cooldown_until ON live_member_state TYPE option<datetime>`,
	`DEFINE FIELD OVERWRITE wrong_remaining ON live_member_state TYPE option<number>`,
	`DEFINE INDEX OVERWRITE idx_lms_session ON live_member_state COLUMNS session_id`,
	`DEFINE INDEX OVERWRITE idx_lms_member ON live_member_state COLUMNS session_id, member_mid UNIQUE`,
] as const

export class QuizEventLogger {
	private db: Surreal | null = null
	private readonly options: Required<QuizEventLoggerOptions>
	private queryChain = Promise.resolve()
	private _sessionId: string | null = null
	private readonly log = getLogger(['kotaete', 'event-logger'])

	constructor(options?: QuizEventLoggerOptions) {
		this.options = { ...DEFAULTS, ...options }
	}

	private ensureDb(): Surreal {
		if (!this.db) throw new Error('QuizEventLogger not initialized — call init() first')
		return this.db
	}

	private chain(fn: () => Promise<void>, label?: string): Promise<void> {
		const run = async () => {
			try {
				await fn()
			} catch (err) {
				this.log.error(
					`fire-and-forget write failed: ${label ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}
		this.queryChain = this.queryChain.then(run, run)
		return this.queryChain
	}

	async init(): Promise<void> {
		const db = new Surreal()
		await db.connect(this.options.endpoint)
		await db.signin({
			username: this.options.username,
			password: this.options.password,
		})
		await db.use({
			namespace: this.options.namespace,
			database: this.options.database,
		})

		for (const q of SCHEMA_QUERIES) {
			await db.query(q)
		}

		this.db = db
	}

	async close(): Promise<void> {
		const sid = this._sessionId
		this._sessionId = null
		if (this.db) {
			await this.db.close()
			this.db = null
		}
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
		const id = result[0]?.[0]?.id
		if (!id) throw new Error('Failed to create quiz_session — no ID returned')
		this._sessionId = id
		return id
	}

	updateSessionState(sessionId: string, opts: {
		currentQuestion?: number
		currentRound?: number
		acceptingAnswers?: boolean
		deadlineAt?: Date | null
	}): void {
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
			await db.query(
				`UPDATE $sid MERGE { ${sets.join(', ')} }`,
				{ sid: sessionId },
			)
		}, 'updateSessionState')
	}

	finishSession(sessionId: string, status?: string): void {
		this.chain(async () => {
			const db = this.ensureDb()
			const finishStatus = status ?? 'finished'
			await db.query(
				`UPDATE $sid SET status = $status, finished_at = time::now()`,
				{ sid: sessionId, status: finishStatus },
			)
		}, 'finishSession')
	}

	// ── Events ──

	logEvent(sessionId: string, opts: {
		groupId: string
		seasonId?: string
		eventType: string
		questionNo?: number
		memberMid?: string
		memberName?: string
		memberClassgroup?: string
		data?: Record<string, unknown>
	}): void {
		this.chain(async () => {
			const db = this.ensureDb()
			await db.query(
				`CREATE quiz_event SET session_id = $sid, group_id = $gid, season_id = $season_id ?? NONE, event_type = $etype, question_no = $qno ?? NONE, member_mid = $mmid ?? NONE, member_name = $mname ?? NONE, member_classgroup = $mcg ?? NONE, data = $data ?? NONE`,
				{
					sid: sessionId,
					gid: opts.groupId,
					season_id: opts.seasonId ?? null,
					etype: opts.eventType,
					qno: opts.questionNo ?? null,
					mmid: opts.memberMid ?? null,
					mname: opts.memberName ?? null,
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
			const name = member.nickname || member.kananame
			const reachedExpr = points > 0 ? `reached_at = time::now()` : `reached_at = $existing[0].reached_at`
			await db.query(
				`LET $existing = (SELECT points, reached_at FROM live_score WHERE session_id = $sid AND member_mid = $mid LIMIT 1);
				IF $existing = [] {
					CREATE live_score SET session_id = $sid, member_mid = $mid, points = $points, reached_at = <datetime>${
					points > 0 ? 'time::now()' : 'NONE'
				}, member_name = $name, member_classgroup = $classgroup;
				} ELSE {
					UPDATE live_score SET points = $points, ${reachedExpr}, member_name = $name, member_classgroup = $classgroup WHERE session_id = $sid AND member_mid = $mid;
				}`,
				{
					sid: sessionId,
					mid: member.mid,
					points,
					name,
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
				{ sid: sessionId },
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
			const name = member.nickname || member.kananame
			const updateCd = opts.cooldownUntil !== undefined
			const cdVal = opts.cooldownUntil ? `<datetime>'${opts.cooldownUntil.toISOString()}'` : 'NONE'
			const cdFragment = updateCd ? `, cooldown_until = ${cdVal}` : ''
			await db.query(
				`LET $existing = (SELECT id FROM live_member_state WHERE session_id = $sid AND member_mid = $mid LIMIT 1);
				IF $existing = [] {
					CREATE live_member_state SET session_id = $sid, member_mid = $mid, member_name = $name${cdFragment}, wrong_remaining = $wr;
				} ELSE {
					UPDATE live_member_state SET member_name = $name${cdFragment}, wrong_remaining = $wr WHERE session_id = $sid AND member_mid = $mid;
				}`,
				{
					sid: sessionId,
					mid: member.mid,
					name,
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
				{ sid: sessionId },
			)
		}, 'deleteMemberStates')
	}
}
