import { mkdir } from 'node:fs/promises'
import {
	COOLDOWN_MS,
	GOD_STAGE_ANNOUNCE_DELAY_MS,
	GOD_STAGE_TIMEOUT_MS,
	QUESTION_TIMEOUT_MS,
	QUESTION_WARNING_LEAD_MS,
	QUIZ_TUNABLES,
	REACTION_COOLDOWN,
	REACTION_CORRECT,
	REACTION_CORRECT_KANJI,
	REACTION_NO_MORE_CHANCE,
} from '../constants.ts'
import { getLogger } from '../logger.ts'
import type { IncomingGroupMessage, NMember, QuizBundle, QuizQuestion } from '../types.ts'
import { normalizeLid } from '../utils/normalize.ts'
import type { SendTextOptions } from '../whatsapp/types.ts'
import { findMatchingAnswer } from './answer-checker.ts'
import type { QuizStateCheckpoint } from './checkpoint.ts'
import {
	formatCooldownWarning,
	formatExplanation,
	formatFinalScoreboard,
	formatGodStageAnnouncement,
	formatIntro,
	formatNextRoundNotice,
	formatQuestion,
	formatQuestionWarning,
	formatRomajiTease,
	formatSeasonOthersMessage,
	formatSeasonTopMessage,
	formatTimeout,
	formatWinner,
	formatWinnerPerfect,
} from './messages.ts'
import { awardCorrectPoints, awardWrongPoints } from './scoring.ts'
import type { SeasonStoreLike } from './season-store.ts'

import type { QuizEventLogger } from './event-logger.ts'
const log = getLogger(['kotaete', 'quiz'])

type SenderPort = {
	sendText: (
		groupId: string,
		text: string,
		opts?: SendTextOptions,
	) => Promise<IncomingGroupMessage['key'] | null>
	sendImageWithCaption: (
		groupId: string,
		imagePath: string,
		caption: string,
	) => Promise<IncomingGroupMessage['key'] | null>
	react: (groupId: string, key: IncomingGroupMessage['key'], emoji: string) => Promise<void>
}

type RunnerState = {
	bundle: QuizBundle
	groupId: string
	byLid: Map<string, NMember>
	byCanonicalLid: Map<string, NMember>
	pointsByMid: Map<string, number>
	scoreReachedAtByMid: Map<string, number>
	questionPointsByMid: Map<string, number>
	cooldowns: Map<string, number>
	noCooldown: boolean
	cooldownWarningSent: Set<string>
	wrongStreak: Map<string, number>
	attemptedSpecial: Set<string>
	index: number
	active: boolean
	acceptingAnswers: boolean
	questionToken: number
	deadlineAtMs: number
	timeoutToken: Timer | null
	warningToken: Timer | null
	questionMessageKey: IncomingGroupMessage['key'] | null
	loggerSessionId: string | null
	roundIndex: number
	roundQuestionIndex: number
	roundQuestionTotal: number
	totalNormalQuestions: number
	roundStartToken: Timer | null
	finishedNotified: boolean
	warningSentForToken: number
}

type Timer = ReturnType<typeof setTimeout>
type QuestionProgress = { index: number; total: number } | null
type SleepFn = (ms: number) => Promise<void>

// Accept typical word endings across scripts, digits, combining marks, and
// Katakana long vowel mark (ー). Keep trailing punctuation/symbols rejected.
const ANSWER_ENDING_RE = /[\p{L}\p{N}\p{M}\u30FC]$/u
const WIB_TIME_HM_FMT = new Intl.DateTimeFormat('id-ID', {
	timeZone: 'Asia/Jakarta',
	hour: '2-digit',
	minute: '2-digit',
	hour12: false,
})

function isValidAnswerEnding(text: string): boolean {
	return ANSWER_ENDING_RE.test(text)
}

function formatWibTimeHint(timestampMs: number, { floor } = { floor: false }): string {
	// Floor/ceil to minute boundary since seconds are omitted from display
	const roundedMs = floor
		? Math.floor(timestampMs / 60_000) * 60_000
		: Math.ceil(timestampMs / 60_000) * 60_000
	return WIB_TIME_HM_FMT.format(new Date(roundedMs)).replaceAll(':', '.')
}

function formatWibTimeColon(timestampMs: number): string {
	return WIB_TIME_HM_FMT.format(new Date(timestampMs)).replaceAll('.', ':')
}

type RoundMeta = {
	index: number
	total: number
	emoji: string
	startAt: Date
	questions: ReadonlyArray<QuizQuestion>
}

/**
 * Check if the user's answer is purely romaji (Latin letters only, possibly with whitespace/hyphens)
 * and matches the first word of any expected answer (indicating they forgot the kana type suffix).
 * Only triggers for single-word inputs — if the user already included a kana type suffix
 * (even an incorrect one like "oshimeeda katakana"), no tease is sent.
 */
function isRomajiWithoutType(input: string, answers: ReadonlyArray<string>): boolean {
	const normalized = input.trim()
	if (!normalized) return false
	// Must be purely Latin/ASCII (romaji) — no CJK, kana, etc.
	if (!/^[a-zA-Z\s\-]+$/.test(normalized)) return false
	// Must be a single word — if there's a second word (kana type), user already knows the format
	const words = normalized.split(/\s+/)
	if (words.length > 1) return false
	const firstWord = words[0]?.trim().toLowerCase()
	if (!firstWord) return false
	for (const answer of answers) {
		const answerFirstWord = answer.split(/\s+/)[0]?.trim().toLowerCase()
		if (answerFirstWord && firstWord === answerFirstWord) return true
	}
	return false
}

function buildRoundPlan(bundle: QuizBundle): RoundMeta[] {
	const sourceRounds = bundle.rounds.length > 0
		? bundle.rounds
		: [{ emoji: '🌟', startAt: bundle.startAt, questions: bundle.questions }]
	return sourceRounds.map((round, index) => ({
		index,
		total: sourceRounds.length,
		emoji: round.emoji,
		startAt: round.startAt,
		questions: round.questions,
	}))
}

export class QuizEngine {
	private state: RunnerState | null = null

	private readonly sleep: SleepFn
	private readonly seasonStore: SeasonStoreLike | null
	private readonly onFinished: (() => void) | null
	private readonly eventLogger: QuizEventLogger | null
	private readonly saveSvg: boolean
	private readonly saveCheckpoint: ((checkpoint: QuizStateCheckpoint) => void) | null

	constructor(
		private readonly sender: SenderPort,
		opts?: {
			sleep?: SleepFn
			seasonStore?: SeasonStoreLike
			onFinished?: () => void
			eventLogger?: QuizEventLogger
			saveSvg?: boolean
			saveCheckpoint?: (checkpoint: QuizStateCheckpoint) => void
		},
	) {
		this.sleep = opts?.sleep ?? ((ms) => Bun.sleep(ms))
		this.seasonStore = opts?.seasonStore ?? null
		this.onFinished = opts?.onFinished ?? null
		this.eventLogger = opts?.eventLogger ?? null
		this.saveSvg = opts?.saveSvg ?? false
		this.saveCheckpoint = opts?.saveCheckpoint ?? null
	}

	private notifyFinished(state: RunnerState): void {
		if (state.finishedNotified) return
		state.finishedNotified = true
		try {
			this.onFinished?.()
		} catch (error) {
			log.warning(`onFinished callback failed: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	private exportCheckpoint(state: RunnerState): QuizStateCheckpoint {
		return {
			version: 1,
			updatedAt: new Date().toISOString(),
			index: state.index,
			roundIndex: state.roundIndex,
			roundQuestionIndex: state.roundQuestionIndex,
			acceptingAnswers: state.acceptingAnswers,
			deadlineAtMs: state.deadlineAtMs,
			questionSentAtMs: state.deadlineAtMs > 0 && state.acceptingAnswers
				? Date.now()
				: 0,
			pointsByMid: Object.fromEntries(state.pointsByMid),
			scoreReachedAtByMid: Object.fromEntries(state.scoreReachedAtByMid),
			questionPointsByMid: Object.fromEntries(state.questionPointsByMid),
			cooldowns: Object.fromEntries(state.cooldowns),
			wrongStreak: Object.fromEntries(state.wrongStreak),
			attemptedSpecial: [...state.attemptedSpecial],
			cooldownWarningSent: [...state.cooldownWarningSent],
			warningAlreadySent: state.warningSentForToken === state.questionToken && state.acceptingAnswers,
			loggerSessionId: state.loggerSessionId,
		}
	}

	private persistCheckpoint(state: RunnerState): void {
		if (!this.saveCheckpoint) return
		try {
			this.saveCheckpoint(this.exportCheckpoint(state))
		} catch (error) {
			log.warning(`checkpoint save failed: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	isRunning(): boolean {
		return this.state?.active === true
	}

	/** Whether the quiz is actively asking questions (past intro, not just scheduled). */
	isActivelyRunning(): boolean {
		const state = this.state
		return state?.active === true && state.index >= 0
	}

	stopCurrentQuiz(): boolean {
		const state = this.state
		if (!state?.active) return false
		state.active = false
		state.acceptingAnswers = false
		if (state.loggerSessionId) {
			this.eventLogger?.finishSession(state.loggerSessionId, 'stopped')
		}
		this.clearAllTimers(state)
		this.notifyFinished(state)
		return true
	}

	async stopCurrentQuizWithFinal(): Promise<boolean> {
		const state = this.state
		if (!state?.active) return false
		state.active = false
		state.acceptingAnswers = false
		if (state.loggerSessionId) {
			this.eventLogger?.finishSession(state.loggerSessionId, 'stopped')
		}
		this.clearAllTimers(state)
		await this.finishQuiz()
		return true
	}

	private clearAllTimers(state: RunnerState): void {
		if (state.timeoutToken) {
			clearTimeout(state.timeoutToken)
			state.timeoutToken = null
		}
		if (state.warningToken) {
			clearTimeout(state.warningToken)
			state.warningToken = null
		}
		if (state.roundStartToken) {
			clearTimeout(state.roundStartToken)
			state.roundStartToken = null
		}
	}

	/** Resume a quiz from a saved checkpoint after daemon restart. */
	async resume(
		bundle: QuizBundle,
		members: ReadonlyArray<NMember>,
		groupId: string,
		checkpoint: QuizStateCheckpoint,
		opts?: { noCooldown?: boolean },
	): Promise<void> {
		if (this.state?.active) {
			throw new Error('[quiz] another quiz is currently running')
		}

		const byLid = new Map<string, NMember>()
		const byCanonicalLid = new Map<string, NMember>()
		for (const member of members) {
			byLid.set(member.lid, member)
			const canonicalLid = normalizeLid(member.lid)
			if (!canonicalLid) {
				throw new Error(`[quiz] invalid member lid: ${member.lid}`)
			}
			byCanonicalLid.set(canonicalLid, member)
		}

		// Reuse existing SurrealDB session if available (preserves live dashboard data)
		let loggerSessionId: string | null = checkpoint.loggerSessionId ?? null
		if (this.eventLogger && loggerSessionId) {
			try {
				this.eventLogger.reactivateSession(loggerSessionId)
			} catch (err) {
				log.warning('failed to reactivate event logger session', { error: err })
				loggerSessionId = null
			}
		} else if (this.eventLogger) {
			loggerSessionId = await this.eventLogger.createSession({
				groupId,
				...(bundle.season?.id ? { seasonId: bundle.season.id } : {}),
				jobId: 'resumed',
				totalQuestions: bundle.questions.length,
				quizDir: bundle.directory,
			}).catch((err) => {
				log.warning('failed to create resumed event logger session', { error: err })
				return null
			}) ?? null
		}

		this.state = {
			bundle,
			groupId,
			byLid,
			byCanonicalLid,
			pointsByMid: new Map(Object.entries(checkpoint.pointsByMid)),
			scoreReachedAtByMid: new Map(Object.entries(checkpoint.scoreReachedAtByMid)),
			questionPointsByMid: new Map(Object.entries(checkpoint.questionPointsByMid)),
			cooldowns: new Map(Object.entries(checkpoint.cooldowns)),
			noCooldown: opts?.noCooldown ?? false,
			cooldownWarningSent: new Set(checkpoint.cooldownWarningSent),
			wrongStreak: new Map(Object.entries(checkpoint.wrongStreak)),
			attemptedSpecial: new Set(checkpoint.attemptedSpecial),
			index: checkpoint.index,
			active: true,
			acceptingAnswers: false,
			questionToken: 0,
			deadlineAtMs: checkpoint.deadlineAtMs,
			timeoutToken: null,
			warningToken: null,
			questionMessageKey: null,
			loggerSessionId,
			roundIndex: checkpoint.roundIndex,
			roundQuestionIndex: checkpoint.roundQuestionIndex,
			roundQuestionTotal: 0,
			totalNormalQuestions: bundle.questions.filter((q) => !q.isSpecialStage).length,
			roundStartToken: null,
			finishedNotified: false,
			warningSentForToken: -1,
		}

		log.info(
			`resuming quiz: index=${checkpoint.index} round=${checkpoint.roundIndex} roundQ=${checkpoint.roundQuestionIndex} accepting=${checkpoint.acceptingAnswers} scores=${
				Object.keys(checkpoint.pointsByMid).length
			}`,
		)

		try {
			await this.resumeDispatch(checkpoint)
		} catch (error) {
			log.error(`resumed quiz loop crashed: ${error instanceof Error ? error.message : String(error)}`)
			if (this.state?.active) {
				await this.finishQuiz()
			}
		}
	}

	/** Determine where to resume based on checkpoint state and dispatch accordingly. */
	private async resumeDispatch(checkpoint: QuizStateCheckpoint): Promise<void> {
		const state = this.state
		if (!state) return

		const rounds = buildRoundPlan(state.bundle)

		// Phase D: all questions done
		if (checkpoint.index >= state.bundle.questions.length - 1 && !checkpoint.acceptingAnswers) {
			log.info('resume: quiz was at/past last question, finishing')
			await this.finishQuiz()
			return
		}

		// Phase B: mid-question with time remaining
		if (checkpoint.acceptingAnswers) {
			const remainingMs = checkpoint.deadlineAtMs - Date.now()
			if (remainingMs > 0) {
				const question = this.currentQuestion()
				if (question) {
					log.info(`resume: mid-question, ${Math.round(remainingMs / 1000)}s remaining`)
					const timeoutMs = Math.min(remainingMs, question.isSpecialStage ? GOD_STAGE_TIMEOUT_MS : QUESTION_TIMEOUT_MS)
					state.deadlineAtMs = Date.now() + timeoutMs

					state.questionToken += 1
					const currentToken = state.questionToken
					state.acceptingAnswers = true

					if (this.sid) {
						this.el?.updateSessionState(this.sid, {
							currentQuestion: question.number,
							currentRound: state.roundIndex,
							acceptingAnswers: true,
							deadlineAt: new Date(state.deadlineAtMs),
						})
						this.el?.logEvent(this.sid, {
							groupId: state.groupId,
							...(state.bundle.season?.id ? { seasonId: state.bundle.season.id } : {}),
							eventType: 'resumed',
							questionNo: question.number,
							data: { remainingMs },
						})
					}

					// Arm warning timer if not already sent
					if (!checkpoint.warningAlreadySent) {
						const warningDelayMs = timeoutMs - QUESTION_WARNING_LEAD_MS
						if (warningDelayMs > 0) {
							state.warningToken = setTimeout(() => {
								void this.handleQuestionWarning(currentToken).catch((error: unknown) => {
									log.error(`handleQuestionWarning failed: ${error instanceof Error ? error.message : String(error)}`)
								})
							}, warningDelayMs)
						}
					}

					state.timeoutToken = setTimeout(() => {
						void this.handleTimeout(currentToken).catch((error: unknown) => {
							log.error(`handleTimeout failed: ${error instanceof Error ? error.message : String(error)}`)
							if (this.state?.active) {
								void this.finishQuiz()
							}
						})
					}, timeoutMs)

					this.persistCheckpoint(state)
					return
				}
			}
			log.info('resume: question deadline expired or not found, advancing')

			// Phase C: between questions (after correct/timeout), advance
			log.info('resume: between questions, advancing')
			await this.moveToNextQuestion()
			return
		}

		// Phase A: never started a question (index === -1)
		log.info('resume: quiz not started yet, running from scratch')
		const firstRound = rounds[0]
		if (!firstRound) {
			throw new Error('[quiz] no round plan available')
		}
		const firstRoundDelay = Math.max(0, firstRound.startAt.getTime() - Date.now())
		if (firstRoundDelay > 0) await this.sleep(firstRoundDelay)
		if (!this.state?.active) return
		state.roundIndex = 0
		state.roundQuestionIndex = -1
		state.roundQuestionTotal = firstRound.questions.length
		await this.moveToNextQuestion()
	}

	async run(
		bundle: QuizBundle,
		members: ReadonlyArray<NMember>,
		groupId: string,
		opts?: { noCooldown?: boolean },
	): Promise<void> {
		if (bundle.questions.length === 0) {
			throw new Error('[quiz] no question markdown files found in quiz directory')
		}
		if (this.state?.active) {
			throw new Error('[quiz] another quiz is currently running')
		}

		const byLid = new Map<string, NMember>()
		const byCanonicalLid = new Map<string, NMember>()
		for (const member of members) {
			byLid.set(member.lid, member)
			const canonicalLid = normalizeLid(member.lid)
			if (!canonicalLid) {
				throw new Error(`[quiz] invalid member lid: ${member.lid}`)
			}
			byCanonicalLid.set(canonicalLid, member)
		}

		const loggerSessionId = this.eventLogger
			? await this.eventLogger.createSession({
				groupId,
				...(bundle.season?.id ? { seasonId: bundle.season.id } : {}),
				jobId: 'engine',
				totalQuestions: bundle.questions.length,
				quizDir: bundle.directory,
			}).catch((err) => {
				log.warning('failed to create event logger session', { error: err })
				return null
			}) ?? null
			: null

		this.state = {
			bundle,
			groupId,
			byLid,
			byCanonicalLid,
			pointsByMid: new Map(),
			scoreReachedAtByMid: new Map(),
			questionPointsByMid: new Map(),
			cooldowns: new Map(),
			noCooldown: opts?.noCooldown ?? false,
			cooldownWarningSent: new Set(),
			wrongStreak: new Map(),
			attemptedSpecial: new Set(),
			index: -1,
			active: true,
			acceptingAnswers: false,
			questionToken: 0,
			deadlineAtMs: 0,
			timeoutToken: null,
			warningToken: null,
			questionMessageKey: null,
			loggerSessionId,
			roundIndex: 0,
			roundQuestionIndex: -1,
			roundQuestionTotal: 0,
			totalNormalQuestions: bundle.questions.filter((q) => !q.isSpecialStage).length,
			roundStartToken: null,
			finishedNotified: false,
			warningSentForToken: -1,
		}

		const roundPlan = buildRoundPlan(bundle)
		const roundsSummary = roundPlan.map((round) => ({
			emoji: round.emoji,
			time: formatWibTimeColon(round.startAt.getTime()),
			count: round.questions.filter((item) => !item.isSpecialStage).length,
		}))

		if (this.seasonStore && bundle.season) {
			if (bundle.season.start) {
				await this.seasonStore.resetGroup(groupId, bundle.season.id)
			}
			await this.seasonStore.setGroupMembers(groupId, members, bundle.season.id)
		}

		const introDelay = Math.max(0, bundle.introAt.getTime() - Date.now())
		if (introDelay > 0) await this.sleep(introDelay)
		if (!this.state?.active) return
		await this.sender.sendText(
			groupId,
			formatIntro(bundle.introAt, bundle.introNote, {
				templates: bundle.messageTemplates,
				rounds: roundsSummary,
			}),
			{ linkPreview: false },
		)

		const firstRound = roundPlan[0]
		if (!firstRound) {
			throw new Error('[quiz] no round plan available')
		}
		const firstRoundDelay = Math.max(0, firstRound.startAt.getTime() - Date.now())
		if (firstRoundDelay > 0) await this.sleep(firstRoundDelay)
		const state = this.state
		if (!state?.active) return

		state.roundIndex = 0
		state.roundQuestionIndex = -1
		state.roundQuestionTotal = firstRound.questions.length
		try {
			await this.moveToNextQuestion()
		} catch (error) {
			log.error(`quiz loop crashed: ${error instanceof Error ? error.message : String(error)}`)
			if (this.state?.active) {
				await this.finishQuiz()
			}
		}
	}

	async onIncomingMessage(incoming: IncomingGroupMessage): Promise<void> {
		const state = this.state
		if (!state?.active) {
			log.debug('drop incoming: quiz inactive')
			return
		}
		if (incoming.groupId !== state.groupId) {
			log.debug(`drop incoming: unexpected group ${incoming.groupId}`)
			return
		}
		log.info(
			`incoming message: text=${JSON.stringify(incoming.text.trim().slice(0, 40))} senderNumber=${
				incoming.senderNumber ?? 'null'
			} senderLid=${
				incoming.senderLid ?? 'null'
			} senderRawJid=${incoming.senderRawJid} accepting=${state.acceptingAnswers}`,
		)
		if (!incoming.text.trim()) {
			log.debug('drop incoming: empty text')
			return
		}
		if (!isValidAnswerEnding(incoming.text.trim())) {
			log.debug(`drop incoming: invalid answer ending text=${JSON.stringify(incoming.text.trim())}`)
			return
		}

		// Strict identity: canonical LID is required for member matching.
		const senderLidRaw = incoming.senderLid
		const senderLid = senderLidRaw ? normalizeLid(senderLidRaw) : null
		const senderPn = incoming.senderNumber
		const member = (senderLidRaw ? state.byLid.get(senderLidRaw) : undefined)
			?? (senderLid ? state.byCanonicalLid.get(senderLid) : undefined)
		if (!member) {
			log.debug(
				`member lookup keys: byLid=${state.byLid.size} byCanonicalLid=${state.byCanonicalLid.size}`,
			)
			log.debug(
				`drop incoming: sender not in members lid=${senderLid ?? 'null'} pn=${
					senderPn ?? 'null'
				} jid=${incoming.senderRawJid}`,
			)
			return
		}

		// Use member.mid as the stable key for all internal tracking
		const memberKey = member.mid

		const question = this.currentQuestion()
		if (!question) {
			log.debug('drop incoming: no current question')
			return
		}
		if (!state.acceptingAnswers) {
			log.debug(`drop incoming: not accepting answers q=${question.number}`)
			return
		}

		log.debug(
			`accept incoming: memberLid=${member.lid} q=${question.number} special=${question.isSpecialStage} accepting=${state.acceptingAnswers}`,
		)

		if (question.isSpecialStage && state.attemptedSpecial.has(memberKey)) {
			log.debug(`special-stage duplicate attempt key=${memberKey} q=${question.number}`)
			return
		}

		if (!question.isSpecialStage) {
			const maxWrong = QUIZ_TUNABLES.wrongAttempts.maxCount
			const remain = state.wrongStreak.get(memberKey) ?? maxWrong
			if (remain < 0) {
				log.debug(`no more chance key=${memberKey} q=${question.number}`)
				return
			}
		}

		if (!question.isSpecialStage && !state.noCooldown) {
			const cooldownUntil = state.cooldowns.get(memberKey) ?? 0
			if (Date.now() < cooldownUntil) {
				log.debug(`cooldown active key=${memberKey} q=${question.number} until=${cooldownUntil}`)
				await this.sender.react(state.groupId, incoming.key, REACTION_COOLDOWN)
				if (!state.cooldownWarningSent.has(memberKey)) {
					state.cooldownWarningSent.add(memberKey)
					const wibTime = formatWibTimeHint(cooldownUntil)
					await this.sender.sendText(
						state.groupId,
						formatCooldownWarning(wibTime, state.bundle.messageTemplates),
						{
							linkPreview: false,
							quotedKey: incoming.key,
						},
					)
				}

				if (state.loggerSessionId) {
					this.eventLogger?.logEvent(state.loggerSessionId, {
						groupId: state.groupId,
						...(state.bundle.season?.id ? { seasonId: state.bundle.season.id } : {}),
						eventType: 'cooldown',
						questionNo: question.number,
						memberMid: member.mid,
						memberName: member.kananame,
						memberClassgroup: member.classgroup,
						data: { cooldownUntilMs: cooldownUntil },
					})
				}
				return
			}
		}

		const matchedAnswer = findMatchingAnswer(incoming.text, question.answers)
		if (matchedAnswer) {
			log.debug(`correct answer accepted key=${memberKey} q=${question.number}`)
			if (!this.claimCurrentQuestion(state)) return
			await this.handleCorrect(incoming, member, question, matchedAnswer)
			return
		}

		log.debug(`wrong answer key=${memberKey} q=${question.number}`)

		if (isRomajiWithoutType(incoming.text, question.answers)) {
			await this.handleWrong(incoming, member, question)
			await this.sender.sendText(
				state.groupId,
				formatRomajiTease(incoming.text.trim(), state.bundle.messageTemplates),
				{ linkPreview: false, quotedKey: incoming.key },
			)
		} else {
			await this.handleWrong(incoming, member, question)
		}
	}

	private currentQuestion(): QuizQuestion | null {
		const state = this.state
		if (!state) return null
		const rounds = buildRoundPlan(state.bundle)
		const activeRound = rounds[state.roundIndex]
		if (!activeRound) return null
		return activeRound.questions[state.roundQuestionIndex] ?? null
	}

	private getQuestionProgress(question: QuizQuestion): QuestionProgress {
		const state = this.state
		if (!state) return null
		if (question.isSpecialStage) return null
		const rounds = buildRoundPlan(state.bundle)
		const flatNormalQuestions = rounds
			.flatMap((round) => round.questions)
			.filter((item) => !item.isSpecialStage)
		const total = flatNormalQuestions.length
		if (total === 0) return null
		const index = flatNormalQuestions.findIndex((item) => item.number === question.number)
		if (index < 0) return null
		return { index: index + 1, total }
	}

	private currentScoreRows(state: RunnerState): Array<{ member: NMember; points: number }> {
		const byMid = new Map<string, NMember>()
		for (const m of state.byLid.values()) {
			byMid.set(m.mid, m)
		}
		return [...state.pointsByMid.entries()]
			.map(([mid, points]) => ({
				mid,
				points,
				member: byMid.get(mid),
				reachedAt: state.scoreReachedAtByMid.get(mid) ?? Infinity,
			}))
			.filter((row): row is { mid: string; points: number; member: NMember; reachedAt: number } => Boolean(row.member))
			.toSorted((a, b) => {
				if (b.points !== a.points) return b.points - a.points
				return a.reachedAt - b.reachedAt
			})
			.map((row) => ({ member: row.member, points: row.points }))
	}

	private async moveToNextQuestion(): Promise<void> {
		const state = this.state
		if (!state?.active) return
		if (state.roundStartToken) {
			clearTimeout(state.roundStartToken)
			state.roundStartToken = null
		}
		const rounds = buildRoundPlan(state.bundle)
		const activeRound = rounds[state.roundIndex]
		if (!activeRound) {
			await this.finishQuiz()
			return
		}

		state.index += 1
		state.roundQuestionIndex += 1
		state.wrongStreak.clear()
		state.attemptedSpecial.clear()
		state.questionPointsByMid.clear()
		state.cooldownWarningSent.clear()

		if (state.roundQuestionIndex >= activeRound.questions.length) {
			const nextRoundIndex = state.roundIndex + 1
			const nextRound = rounds[nextRoundIndex]
			if (!nextRound) {
				await this.finishQuiz()
				return
			}
			const nextRoundNotice = formatNextRoundNotice(
				formatWibTimeHint(nextRound.startAt.getTime()),
				state.bundle.messageTemplates,
			)
			const scoreRows = this.currentScoreRows(state)
			await this.sender.sendText(
				state.groupId,
				formatFinalScoreboard(scoreRows, null, new Date(), state.bundle.messageTemplates, {
					breakMode: true,
					postface: nextRoundNotice,
				}),
				{ linkPreview: false },
			)

			if (this.sid) {
				this.el?.logEvent(this.sid, {
					groupId: state.groupId,
					...(state.bundle.season?.id ? { seasonId: state.bundle.season.id } : {}),
					eventType: 'round_break',
					questionNo: state.index,
				})
			}
			const nextRoundDelay = Math.max(0, nextRound.startAt.getTime() - Date.now())
			if (nextRoundDelay <= 1_000) {
				if (nextRoundDelay > 0) await this.sleep(nextRoundDelay)
				await this.startRound(nextRoundIndex)
				return
			}
			if (nextRoundDelay > 0) {
				log.info(`waiting for next round index=${nextRoundIndex} delayMs=${nextRoundDelay}`)
				state.roundStartToken = setTimeout(() => {
					void this.startRound(nextRoundIndex).catch((error: unknown) => {
						log.error(`startRound failed: ${error instanceof Error ? error.message : String(error)}`)
						if (this.state?.active) {
							void this.finishQuiz()
						}
					})
				}, nextRoundDelay)
				state.roundStartToken.unref?.()
				return
			}
			await this.startRound(nextRoundIndex)
			return
		}

		const currentRound = rounds[state.roundIndex]
		const question = currentRound?.questions[state.roundQuestionIndex] ?? null
		if (!question || !currentRound) {
			await this.finishQuiz()
			return
		}
		state.roundQuestionTotal = currentRound.questions.length

		if (question.isSpecialStage) {
			await this.sender.sendText(
				state.groupId,
				formatGodStageAnnouncement(state.bundle.messageTemplates, {
					points: QUIZ_TUNABLES.points.special,
					timeoutMinutes: GOD_STAGE_TIMEOUT_MS / 60_000,
					delayMinutes: GOD_STAGE_ANNOUNCE_DELAY_MS / 60_000,
				}),
				{
					linkPreview: false,
				},
			)

			if (this.sid) {
				this.el?.logEvent(this.sid, {
					groupId: state.groupId,
					...(state.bundle.season?.id ? { seasonId: state.bundle.season.id } : {}),
					eventType: 'god_stage_announced',
					data: {
						points: QUIZ_TUNABLES.points.special,
						timeoutMinutes: GOD_STAGE_TIMEOUT_MS / 60_000,
					},
				})
			}
			await this.sleep(GOD_STAGE_ANNOUNCE_DELAY_MS)
		}

		const progress = this.getQuestionProgress(question)
		const timeoutMs = question.isSpecialStage ? GOD_STAGE_TIMEOUT_MS : QUESTION_TIMEOUT_MS
		state.deadlineAtMs = Date.now() + timeoutMs
		const cooldownEntries = !question.isSpecialStage && state.cooldowns.size > 0
			? this.buildCooldownEntries(state)
			: null
		const caption = formatQuestion(
			question,
			progress,
			formatWibTimeHint(state.deadlineAtMs, { floor: true }),
			state.bundle.messageTemplates,
			cooldownEntries,
		)
		if (question.imagePath) {
			state.questionMessageKey = await this.sender.sendImageWithCaption(state.groupId, question.imagePath, caption)
		} else {
			state.questionMessageKey = await this.sender.sendText(state.groupId, caption, { linkPreview: false })
		}

		state.questionToken += 1
		const currentToken = state.questionToken
		state.acceptingAnswers = true

		if (this.sid) {
			this.el?.updateSessionState(this.sid, {
				currentQuestion: question.number,
				currentRound: state.roundIndex,
				acceptingAnswers: true,
				deadlineAt: new Date(state.deadlineAtMs),
			})
			this.el?.logEvent(this.sid, {
				groupId: state.groupId,
				...(state.bundle.season?.id ? { seasonId: state.bundle.season.id } : {}),
				eventType: question.isSpecialStage ? 'god_stage_asked' : 'question_asked',
				questionNo: question.number,
				data: {
					hint: question.text,
					hasImage: !!question.imagePath,
					imagePath: question.imagePath ?? undefined,
					timeoutMs: question.isSpecialStage ? GOD_STAGE_TIMEOUT_MS : QUESTION_TIMEOUT_MS,
				},
			})
		}
		if (state.warningToken) {
			clearTimeout(state.warningToken)
			state.warningToken = null
		}
		const warningDelayMs = timeoutMs - QUESTION_WARNING_LEAD_MS
		if (warningDelayMs > 0) {
			state.warningToken = setTimeout(() => {
				void this.handleQuestionWarning(currentToken).catch((error: unknown) => {
					log.error(`handleQuestionWarning failed: ${error instanceof Error ? error.message : String(error)}`)
				})
			}, warningDelayMs)
		}
		if (state.timeoutToken) clearTimeout(state.timeoutToken)
		state.timeoutToken = setTimeout(() => {
			void this.handleTimeout(currentToken).catch((error: unknown) => {
				log.error(`handleTimeout failed: ${error instanceof Error ? error.message : String(error)}`)
				if (this.state?.active) {
					void this.finishQuiz()
				}
			})
		}, timeoutMs)

		this.persistCheckpoint(state)
	}

	private claimCurrentQuestion(state: RunnerState): boolean {
		if (!state.acceptingAnswers) return false
		state.acceptingAnswers = false
		if (state.warningToken) {
			clearTimeout(state.warningToken)
			state.warningToken = null
		}
		if (state.timeoutToken) {
			clearTimeout(state.timeoutToken)
			state.timeoutToken = null
		}
		return true
	}
	private buildCooldownEntries(state: RunnerState): Array<{ name: string; classgroup: string; time: string }> {
		const now = Date.now()
		const byMid = new Map<string, NMember>()
		for (const m of state.byLid.values()) {
			byMid.set(m.mid, m)
		}
		const entries: Array<{ name: string; classgroup: string; time: string }> = []
		for (const [mid, cooldownUntil] of state.cooldowns) {
			if (cooldownUntil <= now) continue
			const member = byMid.get(mid)
			if (!member) continue
			entries.push({
				name: member.kananame,
				classgroup: member.classgroup,
				time: `${formatWibTimeHint(cooldownUntil)} WIB`,
			})
		}
		return entries
	}

	private async handleQuestionWarning(token: number): Promise<void> {
		const state = this.state
		if (!state?.active) return
		if (token !== state.questionToken) return
		if (!state.acceptingAnswers) return

		const question = this.currentQuestion()
		const warningBase = formatQuestionWarning(state.bundle.messageTemplates)
		const warningText = question?.extraHint
			? `${warningBase}\n💡 _${question.extraHint}_`
			: warningBase

		const quotedKey = state.questionMessageKey ?? undefined
		await this.sender.sendText(state.groupId, warningText, {
			linkPreview: false,
			...(quotedKey ? { quotedKey } : {}),
		})
		state.warningToken = null
		state.warningSentForToken = state.questionToken

		if (this.state?.loggerSessionId) {
			this.eventLogger?.logEvent(this.state.loggerSessionId, {
				groupId: this.state.groupId,
				...(this.state.bundle.season?.id ? { seasonId: this.state.bundle.season.id } : {}),
				eventType: 'warning',
				...(this.currentQuestion()?.number ? { questionNo: this.currentQuestion()!.number } : {}),
				data: { extraHint: question?.extraHint },
			})
		}
	}

	private async handleCorrect(
		incoming: IncomingGroupMessage,
		member: NMember,
		question: QuizQuestion,
		matchedAnswer: string,
	): Promise<void> {
		const state = this.state
		if (!state?.active) return

		// Look up the extraPts for the specific answer type that matched.
		// Fall back to question.extraPts when answerExtraPts is not populated
		// (e.g. test bundles or direct QuizQuestion construction).
		const matchedExtraPts = question.answerExtraPts?.has(matchedAnswer)
			? (question.answerExtraPts.get(matchedAnswer) ?? 0)
			: (question.extraPts ?? 0)
		const hasExtraPts = matchedExtraPts > 0
		await this.sender.react(state.groupId, incoming.key, hasExtraPts ? REACTION_CORRECT_KANJI : REACTION_CORRECT)

		const currentQuestionPoints = state.questionPointsByMid.get(member.mid) ?? 0
		let gained = awardCorrectPoints(currentQuestionPoints, question.isSpecialStage)
		gained += matchedExtraPts

		if (gained !== 0) {
			state.pointsByMid.set(member.mid, (state.pointsByMid.get(member.mid) ?? 0) + gained)
			state.scoreReachedAtByMid.set(member.mid, Date.now())

			if (this.sid) {
				const totalPts = state.pointsByMid.get(member.mid) ?? 0
				this.el?.upsertLiveScore(this.sid, member, totalPts)
				this.el?.upsertMemberState(this.sid, member, {
					cooldownUntil: !question.isSpecialStage ? new Date(Date.now() + COOLDOWN_MS) : null,
				})
				this.el?.logEvent(this.sid, {
					groupId: state.groupId,
					...(state.bundle.season?.id ? { seasonId: state.bundle.season.id } : {}),
					eventType: 'answer_correct',
					questionNo: question.number,
					memberMid: member.mid,
					memberName: member.kananame,
					memberClassgroup: member.classgroup,
					data: {
						matchedAnswer,
						gained,
						totalGained: currentQuestionPoints + gained,
						totalPoints: totalPts,
						hasExtraPts,
						isSpecialStage: question.isSpecialStage,
					},
				})
				this.el?.updateSessionState(this.sid, { acceptingAnswers: false, deadlineAt: null })
			}
			state.questionPointsByMid.set(member.mid, currentQuestionPoints + gained)
			if (this.seasonStore && state.bundle.season) {
				await this.seasonStore.addPoints(
					state.groupId,
					[...state.byLid.values()],
					new Map([[member.mid, gained]]),
					state.bundle.season.id,
				)
			}

			this.persistCheckpoint(state)
		}

		if (!question.isSpecialStage) state.cooldowns.set(member.mid, Date.now() + COOLDOWN_MS)

		await this.sender.sendText(
			state.groupId,
			hasExtraPts
				? formatWinnerPerfect(
					member,
					question.answers,
					currentQuestionPoints + gained,
					question.answerExtraPts,
					state.bundle.messageTemplates,
				)
				: formatWinner(
					member,
					question.answers,
					currentQuestionPoints + gained,
					question.answerExtraPts,
					state.bundle.messageTemplates,
				),
			{
				linkPreview: false,
				quotedKey: incoming.key,
			},
		)
		const explanation = formatExplanation(question, this.getQuestionProgress(question), state.bundle.messageTemplates)
		if (explanation) await this.sender.sendText(state.groupId, explanation, { linkPreview: false })

		await this.moveToNextQuestion()
	}

	private async handleWrong(
		incoming: IncomingGroupMessage,
		member: NMember,
		question: QuizQuestion,
	): Promise<void> {
		const state = this.state
		if (!state?.active) return
		if (!state.acceptingAnswers) return

		if (question.isSpecialStage) {
			state.attemptedSpecial.add(member.mid)
			await this.sender.react(state.groupId, incoming.key, REACTION_NO_MORE_CHANCE)

			if (this.state?.loggerSessionId) {
				this.eventLogger?.logEvent(this.state.loggerSessionId, {
					groupId: this.state.groupId,
					...(this.state.bundle.season?.id ? { seasonId: this.state.bundle.season.id } : {}),
					eventType: 'special_duplicate',
					questionNo: question.number,
					memberMid: member.mid,
					memberName: member.kananame,
					memberClassgroup: member.classgroup,
				})
			}
			return
		}

		const key = member.mid
		const maxWrong = QUIZ_TUNABLES.wrongAttempts.maxCount
		const remain = state.wrongStreak.get(key) ?? maxWrong
		if (remain < 0) return

		const gained = awardWrongPoints(question.isSpecialStage)
		if (gained !== 0) {
			state.pointsByMid.set(member.mid, (state.pointsByMid.get(member.mid) ?? 0) + gained)
			state.scoreReachedAtByMid.set(member.mid, Date.now())
			state.questionPointsByMid.set(
				member.mid,
				(state.questionPointsByMid.get(member.mid) ?? 0) + gained,
			)
			if (this.seasonStore && state.bundle.season) {
				await this.seasonStore.addPoints(
					state.groupId,
					[...state.byLid.values()],
					new Map([[member.mid, gained]]),
					state.bundle.season.id,
				)
			}
		}

		const emojiStreak = QUIZ_TUNABLES.wrongAttempts.emojiStreak
		const reaction = emojiStreak[emojiStreak.length - 1 - remain] ?? REACTION_NO_MORE_CHANCE
		await this.sender.react(state.groupId, incoming.key, reaction)
		state.wrongStreak.set(key, remain - 1)

		if (this.sid) {
			const totalPts = state.pointsByMid.get(member.mid) ?? 0
			this.el?.upsertLiveScore(this.sid, member, totalPts)
			this.el?.upsertMemberState(this.sid, member, {
				wrongRemaining: remain - 1,
			})
			this.el?.logEvent(this.sid, {
				groupId: state.groupId,
				...(state.bundle.season?.id ? { seasonId: state.bundle.season.id } : {}),
				eventType: 'answer_wrong',
				questionNo: question.number,
				memberMid: member.mid,
				memberName: member.kananame,
				memberClassgroup: member.classgroup,
				data: {
					answerText: incoming.text.trim(),
					gained,
					totalPoints: totalPts,
					remainingChances: remain - 1,
				},
			})
		}

		this.persistCheckpoint(state)
	}

	private async handleTimeout(token: number): Promise<void> {
		const state = this.state
		const question = this.currentQuestion()
		if (!state?.active || !question) return
		if (token !== state.questionToken) return
		if (!state.acceptingAnswers) return
		state.acceptingAnswers = false
		if (state.warningToken) {
			clearTimeout(state.warningToken)
			state.warningToken = null
		}
		state.timeoutToken = null

		if (this.sid) {
			this.el?.logEvent(this.sid, {
				groupId: state.groupId,
				...(state.bundle.season?.id ? { seasonId: state.bundle.season.id } : {}),
				eventType: 'timeout',
				questionNo: question.number,
				data: { answers: [...question.answers] },
			})
			this.el?.updateSessionState(this.sid, { acceptingAnswers: false, deadlineAt: null })
		}
		await this.sender.sendText(
			state.groupId,
			formatTimeout(question.answers, state.bundle.messageTemplates),
			{
				linkPreview: false,
				...(state.questionMessageKey ? { quotedKey: state.questionMessageKey } : {}),
			},
		)

		const explanation = formatExplanation(question, this.getQuestionProgress(question), state.bundle.messageTemplates)
		if (explanation) await this.sender.sendText(state.groupId, explanation, { linkPreview: false })

		await this.moveToNextQuestion()
	}

	private async finishQuiz(): Promise<void> {
		const state = this.state
		if (!state) return
		state.active = false
		state.acceptingAnswers = false
		this.clearAllTimers(state)
		this.notifyFinished(state)

		if (this.sid) {
			this.el?.finishSession(this.sid)
			this.el?.logEvent(this.sid, {
				groupId: state.groupId,
				...(state.bundle.season?.id ? { seasonId: state.bundle.season.id } : {}),
				eventType: 'quiz_finished',
				data: {
					totalParticipants: state.pointsByMid.size,
					finalScores: Object.fromEntries(state.pointsByMid),
				},
			})
		}

		const rows = this.currentScoreRows(state)

		await this.sender.sendText(
			state.groupId,
			formatFinalScoreboard(
				rows,
				state.bundle.outroNote,
				new Date(),
				state.bundle.messageTemplates,
			),
			{ linkPreview: false },
		)

		// Season handling
		if (!this.seasonStore || !state.bundle.season) return

		const season = state.bundle.season

		// Season end: send special congratulation messages
		if (season.end) {
			const seasonPoints = await this.seasonStore.getPointsAsync(state.groupId, season.id)
			const seasonMembers = await this.seasonStore.getMembersAsync(state.groupId, season.id)
			const seasonReachedAt = await this.seasonStore.getReachedAtAsync(state.groupId, season.id)

			const seasonByMid = new Map<string, NMember>()
			for (const m of state.byLid.values()) {
				seasonByMid.set(m.mid, m)
			}
			const seasonRows = [...seasonPoints.entries()]
				.map(([mid, points]) => ({
					mid,
					points,
					reachedAt: seasonReachedAt.get(mid) ?? Infinity,
					member: seasonByMid.get(mid) ?? seasonMembers.find((m) => m.mid === mid) ?? null,
				}))
				.filter((row): row is { mid: string; points: number; reachedAt: number; member: NMember } =>
					Boolean(row.member)
				)
				.toSorted((a, b) => {
					if (b.points !== a.points) return b.points - a.points
					return a.reachedAt - b.reachedAt
				})
				.map((row) => ({ member: row.member, points: row.points }))

			if (seasonRows.length > 0) {
				const top3 = seasonRows.slice(0, 3)

				// Generate and send scoreboard image for top 7
				const topSlots = seasonRows.slice(0, 7).map((entry, index) => ({
					rank: index + 1,
					kananame: entry.member.kananame,
					nickname: entry.member.nickname,
					classgroup: entry.member.classgroup,
					score: entry.points,
					mid: entry.member.mid,
				}))
				try {
					const { generateSeasonScoreboardImage } = await import('./season-scoreboard.ts')
					await mkdir(state.bundle.directory, { recursive: true })
					const groupIdStem = state.groupId.split('@')[0] ?? state.groupId
					const scoreboardOutput = await generateSeasonScoreboardImage(topSlots, {
						...(season.scoreboardTemplate ? { templatePath: season.scoreboardTemplate } : {}),
						outputDir: state.bundle.directory,
						outputStem: `scoreboard-${groupIdStem}`,
						...(season.caption ? { caption: season.caption } : {}),
						...(this.saveSvg ? { saveSvg: true } : {}),
					})
					const imgCaption = formatSeasonTopMessage(top3, season.caption)
					await this.sender.sendImageWithCaption(state.groupId, scoreboardOutput.jpgPath, imgCaption)
				} catch (error) {
					log.warning(
						`season scoreboard image generation failed: ${error instanceof Error ? error.message : String(error)}`,
					)
				}

				// Send others message only when there are participants beyond top 3
				const othersMessage = formatSeasonOthersMessage(seasonRows)
				if (othersMessage) {
					await this.sender.sendText(state.groupId, othersMessage, { linkPreview: false })
				}
			}
		}
	}

	private async startRound(roundIndex: number): Promise<void> {
		const state = this.state
		if (!state?.active) return
		if (state.roundStartToken) {
			clearTimeout(state.roundStartToken)
			state.roundStartToken = null
		}

		const rounds = buildRoundPlan(state.bundle)
		const round = rounds[roundIndex]
		if (!round) {
			await this.finishQuiz()
			return
		}

		state.roundIndex = roundIndex
		state.roundQuestionIndex = -1
		state.roundQuestionTotal = round.questions.length
		await this.moveToNextQuestion()
	}

	private get sid(): string | null {
		return this.state?.loggerSessionId ?? null
	}

	private get el(): QuizEventLogger | null {
		return this.eventLogger
	}
}
