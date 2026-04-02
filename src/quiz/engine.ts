import {
	COOLDOWN_MS,
	QUESTION_TIMEOUT_MS,
	REACTION_COOLDOWN,
	REACTION_CORRECT,
	REACTION_NO_MORE_CHANCE,
	REACTION_WRONG_STREAK,
} from '../constants.ts'
import { getLogger } from '../logger.ts'
import type { IncomingGroupMessage, NMember, QuizBundle, QuizQuestion } from '../types.ts'
import type { SendTextOptions } from '../whatsapp/types.ts'
import { isCorrectAnswer } from './answer-checker.ts'
import { formatExplanation, formatFinalScoreboard, formatIntro, formatQuestion, formatWinner } from './messages.ts'
import { awardCorrectPoints, awardWrongPoints } from './scoring.ts'

const log = getLogger(['kotaete', 'quiz'])

type SenderPort = {
	sendText: (groupId: string, text: string, opts?: SendTextOptions) => Promise<void>
	sendImageWithCaption: (groupId: string, imagePath: string, caption: string) => Promise<void>
	react: (groupId: string, key: IncomingGroupMessage['key'], emoji: string) => Promise<void>
}

type RunnerState = {
	bundle: QuizBundle
	groupId: string
	byNumber: Map<string, NMember>
	pointsByNumber: Map<string, number>
	questionPointsByNumber: Map<string, number>
	cooldowns: Map<string, number>
	disableCooldown: boolean
	cooldownWarningSent: boolean
	wrongStreak: Map<string, number>
	attemptedSpecial: Set<string>
	index: number
	active: boolean
	acceptingAnswers: boolean
	questionToken: number
	deadlineAtMs: number
	timeoutToken: Timer | null
}

type Timer = ReturnType<typeof setTimeout>
type QuestionProgress = { index: number; total: number } | null
type SleepFn = (ms: number) => Promise<void>

const GOD_STAGE_ANNOUNCEMENT = [
	'🚨 *INCOMING*',
	'🪽 *神のステージ! (Kami no Stage!)*',
	'',
	'Khusus stage ini, siapa pun bisa menjawab soal. Ketentuannya:',
	'🌸 Jawaban benar = 25 poin',
	'🙊 Satu kali jawab per anggota',
	'⏰ Masa aktif soal 30 menit',
	'',
	'Soal akan muncul dalam 30 detik! 🐻‍❄️',
].join('\n')

const GOD_STAGE_TIMEOUT_MS = 30 * 60 * 1000
const GOD_STAGE_ANNOUNCEMENT_DELAY_MS = 30 * 1000

const ANSWER_ENDING_RE = /[\p{Script=Latin}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]$/u
const WIB_TIME_FMT = new Intl.DateTimeFormat('id-ID', {
	timeZone: 'Asia/Jakarta',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hour12: false,
})

function isValidAnswerEnding(text: string): boolean {
	return ANSWER_ENDING_RE.test(text)
}

function formatWibTime(timestampMs: number): string {
	return WIB_TIME_FMT.format(new Date(timestampMs))
}

export class QuizEngine {
	private state: RunnerState | null = null

	private readonly sleep: SleepFn

	constructor(private readonly sender: SenderPort, opts?: { sleep?: SleepFn }) {
		this.sleep = opts?.sleep ?? ((ms) => Bun.sleep(ms))
	}

	isRunning(): boolean {
		return this.state?.active === true
	}

	stopCurrentQuiz(): boolean {
		const state = this.state
		if (!state?.active) return false
		state.active = false
		state.acceptingAnswers = false
		if (state.timeoutToken) {
			clearTimeout(state.timeoutToken)
			state.timeoutToken = null
		}
		return true
	}

	async run(
		bundle: QuizBundle,
		members: ReadonlyArray<NMember>,
		groupId: string,
		opts?: { disableCooldown?: boolean },
	): Promise<void> {
		if (bundle.questions.length === 0) {
			throw new Error('[quiz] no question markdown files found in quiz directory')
		}
		if (this.state?.active) {
			throw new Error('[quiz] another quiz is currently running')
		}

		const byNumber = new Map<string, NMember>()
		for (const member of members) {
			byNumber.set(member.number, member)
		}

		this.state = {
			bundle,
			groupId,
			byNumber,
			pointsByNumber: new Map(),
			questionPointsByNumber: new Map(),
			cooldowns: new Map(),
			disableCooldown: opts?.disableCooldown ?? false,
			cooldownWarningSent: false,
			wrongStreak: new Map(),
			attemptedSpecial: new Set(),
			index: -1,
			active: true,
			acceptingAnswers: false,
			questionToken: 0,
			deadlineAtMs: 0,
			timeoutToken: null,
		}

		const introDelay = Math.max(0, bundle.introAt.getTime() - Date.now())
		if (introDelay > 0) await this.sleep(introDelay)
		await this.sender.sendText(groupId, formatIntro(bundle.introAt, bundle.introNote), { linkPreview: false })

		const startDelay = Math.max(0, bundle.startAt.getTime() - Date.now())
		if (startDelay > 0) await this.sleep(startDelay)
		await this.moveToNextQuestion()
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
		if (!incoming.text.trim()) {
			log.debug('drop incoming: empty text')
			return
		}
		if (!isValidAnswerEnding(incoming.text.trim())) {
			log.debug(`drop incoming: invalid answer ending text=${JSON.stringify(incoming.text.trim())}`)
			return
		}

		const number = incoming.senderNumber
		if (!number) {
			log.debug(`drop incoming: unresolved sender jid=${incoming.senderRawJid}`)
			return
		}
		const member = state.byNumber.get(number)
		if (!member) {
			log.debug(`drop incoming: sender not in members number=${number} jid=${incoming.senderRawJid}`)
			return
		}

		const question = this.currentQuestion()
		if (!question) {
			log.debug('drop incoming: no current question')
			return
		}
		if (!state.acceptingAnswers) {
			log.debug(`drop incoming: not accepting answers q=${question.number}`)
			return
		}

		if (question.isSpecialStage && state.attemptedSpecial.has(number)) {
			log.debug(`special-stage duplicate attempt number=${number} q=${question.number}`)
			await this.sender.react(state.groupId, incoming.key, REACTION_NO_MORE_CHANCE)
			return
		}

		if (!question.isSpecialStage && !state.disableCooldown) {
			const cooldownUntil = state.cooldowns.get(number) ?? 0
			if (Date.now() < cooldownUntil) {
				log.debug(`cooldown active number=${number} q=${question.number} until=${cooldownUntil}`)
				await this.sender.react(state.groupId, incoming.key, REACTION_COOLDOWN)
				if (!state.cooldownWarningSent) {
					state.cooldownWarningSent = true
					const wibTime = formatWibTime(cooldownUntil)
					await this.sender.sendText(
						state.groupId,
						`Baru bisa jawab lagi mulai ${wibTime} WIB!`,
						{
							linkPreview: false,
							quotedKey: incoming.key,
						},
					)
				}
				return
			}
		}

		if (isCorrectAnswer(incoming.text, question.answers)) {
			log.debug(`correct answer accepted number=${number} q=${question.number}`)
			if (!this.claimCurrentQuestion(state)) return
			await this.handleCorrect(incoming, member, question)
			return
		}

		log.debug(`wrong answer number=${number} q=${question.number}`)
		await this.handleWrong(incoming, member, question)
	}

	private currentQuestion(): QuizQuestion | null {
		const state = this.state
		if (!state) return null
		return state.bundle.questions[state.index] ?? null
	}

	private getQuestionProgress(question: QuizQuestion): QuestionProgress {
		const state = this.state
		if (!state) return null
		if (question.isSpecialStage) return null
		const normalQuestions = state.bundle.questions.filter((item) => !item.isSpecialStage)
		const total = normalQuestions.length
		if (total === 0) return null
		const index = normalQuestions.findIndex((item) => item.number === question.number)
		if (index < 0) return null
		return { index: index + 1, total }
	}

	private async moveToNextQuestion(): Promise<void> {
		const state = this.state
		if (!state?.active) return

		state.index += 1
		state.wrongStreak.clear()
		state.attemptedSpecial.clear()
		state.questionPointsByNumber.clear()
		state.cooldownWarningSent = false

		const question = this.currentQuestion()
		if (!question) {
			await this.finishQuiz()
			return
		}

		if (question.isSpecialStage) {
			await this.sender.sendText(state.groupId, GOD_STAGE_ANNOUNCEMENT, { linkPreview: false })
			await this.sleep(GOD_STAGE_ANNOUNCEMENT_DELAY_MS)
		}

		const progress = this.getQuestionProgress(question)
		const caption = formatQuestion(question, progress)
		if (question.imagePath) {
			await this.sender.sendImageWithCaption(state.groupId, question.imagePath, caption)
		} else {
			await this.sender.sendText(state.groupId, caption, { linkPreview: false })
		}

		state.questionToken += 1
		const currentToken = state.questionToken
		state.acceptingAnswers = true
		const timeoutMs = question.isSpecialStage ? GOD_STAGE_TIMEOUT_MS : QUESTION_TIMEOUT_MS
		state.deadlineAtMs = Date.now() + timeoutMs
		if (state.timeoutToken) clearTimeout(state.timeoutToken)
		state.timeoutToken = setTimeout(async () => {
			await this.handleTimeout(currentToken)
		}, timeoutMs)
	}

	private claimCurrentQuestion(state: RunnerState): boolean {
		if (!state.acceptingAnswers) return false
		state.acceptingAnswers = false
		if (state.timeoutToken) {
			clearTimeout(state.timeoutToken)
			state.timeoutToken = null
		}
		return true
	}

	private async handleCorrect(
		incoming: IncomingGroupMessage,
		member: NMember,
		question: QuizQuestion,
	): Promise<void> {
		const state = this.state
		if (!state?.active) return

		await this.sender.react(state.groupId, incoming.key, REACTION_CORRECT)

		const currentQuestionPoints = state.questionPointsByNumber.get(member.number) ?? 0
		const gained = awardCorrectPoints(currentQuestionPoints, question.isSpecialStage)
		state.pointsByNumber.set(member.number, (state.pointsByNumber.get(member.number) ?? 0) + gained)
		state.questionPointsByNumber.set(member.number, currentQuestionPoints + gained)
		if (!question.isSpecialStage) state.cooldowns.set(member.number, Date.now() + COOLDOWN_MS)

		await this.sender.sendText(state.groupId, formatWinner(member, question.answers), {
			linkPreview: false,
			quotedKey: incoming.key,
		})
		const explanation = formatExplanation(question, this.getQuestionProgress(question))
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
			state.attemptedSpecial.add(member.number)
			await this.sender.react(state.groupId, incoming.key, REACTION_NO_MORE_CHANCE)
			return
		}

		const key = member.number
		const remain = state.wrongStreak.get(key) ?? 2
		if (remain < 0) return

		const gained = awardWrongPoints(question.isSpecialStage)
		if (gained > 0) {
			state.pointsByNumber.set(member.number, (state.pointsByNumber.get(member.number) ?? 0) + gained)
			state.questionPointsByNumber.set(
				member.number,
				(state.questionPointsByNumber.get(member.number) ?? 0) + gained,
			)
		}

		const reaction = REACTION_WRONG_STREAK[2 - remain] ?? REACTION_NO_MORE_CHANCE
		await this.sender.react(state.groupId, incoming.key, reaction)
		state.wrongStreak.set(key, remain - 1)
	}

	private async handleTimeout(token: number): Promise<void> {
		const state = this.state
		const question = this.currentQuestion()
		if (!state?.active || !question) return
		if (token !== state.questionToken) return
		if (!state.acceptingAnswers) return
		state.acceptingAnswers = false
		state.timeoutToken = null

		await this.sender.sendText(
			state.groupId,
			`⏱️ Waktu habis untuk soal ini.\n✅ ${question.answers.map((a) => `_${a}_`).join(' / ')}`,
			{ linkPreview: false },
		)

		const explanation = formatExplanation(question, this.getQuestionProgress(question))
		if (explanation) await this.sender.sendText(state.groupId, explanation, { linkPreview: false })

		await this.moveToNextQuestion()
	}

	private async finishQuiz(): Promise<void> {
		const state = this.state
		if (!state) return
		state.active = false
		state.acceptingAnswers = false
		if (state.timeoutToken) {
			clearTimeout(state.timeoutToken)
			state.timeoutToken = null
		}

		const rows = [...state.pointsByNumber.entries()]
			.map(([number, points]) => ({ number, points, member: state.byNumber.get(number) }))
			.filter((row): row is { number: string; points: number; member: NMember } => Boolean(row.member))
			.toSorted((a, b) => {
				if (b.points !== a.points) return b.points - a.points
				return a.number.localeCompare(b.number)
			})

		await this.sender.sendText(
			state.groupId,
			formatFinalScoreboard(rows.map((row) => ({ member: row.member, points: row.points })), state.bundle.outroNote),
			{ linkPreview: false },
		)
	}
}
