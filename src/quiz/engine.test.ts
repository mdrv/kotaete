import { afterEach, describe, expect, mock, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingGroupMessage, NMember, QuizBundle } from '../types.ts'
import type { SendTextOptions } from '../whatsapp/types.ts'
import { QuizEngine } from './engine.ts'
import { SeasonStore } from './season-store.ts'

function makeBundle(): QuizBundle {
	const now = Date.now()
	const questions = [
		{
			number: 1,
			text: 'Q1',
			answers: ['abc'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		},
		{
			number: 2,
			text: 'Q2',
			answers: ['xyz'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		},
	]
	return {
		directory: '/tmp/quiz',
		introAt: new Date(now),
		startAt: new Date(now),
		rounds: [
			{
				emoji: '🌟',
				startAt: new Date(now),
				questions,
			},
		],
		introNote: null,
		outroNote: null,
		messageTemplates: {},
		questions,
	}
}

function makeBundleWithSpecial(): QuizBundle {
	const now = Date.now()
	const questions = [
		{
			number: 1,
			text: 'Q1',
			answers: ['abc'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		},
		{
			number: 99,
			text: 'Q99',
			answers: ['kami'],
			explanation: '',
			imagePath: null,
			isSpecialStage: true,
		},
	]
	return {
		directory: '/tmp/quiz',
		introAt: new Date(now),
		startAt: new Date(now),
		rounds: [
			{
				emoji: '🌟',
				startAt: new Date(now),
				questions,
			},
		],
		introNote: null,
		outroNote: null,
		messageTemplates: {},
		questions,
	}
}

function makeSingleQuestionBundle(): QuizBundle {
	const now = Date.now()
	const questions = [
		{
			number: 1,
			text: 'Q1',
			answers: ['abc'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		},
	]
	return {
		directory: '/tmp/quiz',
		introAt: new Date(now),
		startAt: new Date(now),
		rounds: [
			{
				emoji: '🌟',
				startAt: new Date(now),
				questions,
			},
		],
		introNote: null,
		outroNote: null,
		messageTemplates: {},
		questions,
	}
}

function makeSingleQuestionKanjiBundle(): QuizBundle {
	const now = Date.now()
	const questions = [
		{
			number: 1,
			text: 'Q1',
			answers: ['漢字'],
			kanjiAnswers: ['漢字'],
			extraPts: 2,
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		},
	]
	return {
		directory: '/tmp/quiz',
		introAt: new Date(now),
		startAt: new Date(now),
		rounds: [
			{
				emoji: '🌟',
				startAt: new Date(now),
				questions,
			},
		],
		introNote: null,
		outroNote: null,
		messageTemplates: {},
		questions,
	}
}

function makeSingleQuestionLongVowelBundle(): QuizBundle {
	const now = Date.now()
	const questions = [
		{
			number: 1,
			text: 'Q1',
			answers: ['スーパー'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		},
	]
	return {
		directory: '/tmp/quiz',
		introAt: new Date(now),
		startAt: new Date(now),
		rounds: [
			{
				emoji: '🌟',
				startAt: new Date(now),
				questions,
			},
		],
		introNote: null,
		outroNote: null,
		messageTemplates: {},
		questions,
	}
}

function makeMember(overrides?: Partial<NMember>): NMember {
	return {
		mid: '1',
		kananame: 'User',
		nickname: 'User',
		classgroup: 'A',
		lid: '628111@lid',
		pn: '628111',
		...overrides,
	}
}

function makeIncoming(overrides?: Partial<IncomingGroupMessage>): IncomingGroupMessage {
	return {
		groupId: '120@g.us',
		senderRawJid: '628111@s.whatsapp.net',
		senderNumber: '628111',
		senderLid: '628111@lid',
		text: 'abc',
		key: {
			id: 'MSG-1',
			remoteJid: '120@g.us',
			participant: '628111@s.whatsapp.net',
			fromMe: false,
		},
		...overrides,
	}
}

function createEngine(opts?: { seasonStore?: SeasonStore; onFinished?: () => void }) {
	const sleep = mock(async (_ms: number) => undefined)
	const sendText = mock(
		async (_groupId: string, _text: string, _opts?: SendTextOptions) => ({
			id: `OUT-${Math.random().toString(36).slice(2, 8)}`,
			remoteJid: _groupId,
			fromMe: true,
		}),
	)
	const sendImageWithCaption = mock(async (_groupId: string, _imagePath: string, _caption: string) => ({
		id: `OUT-IMG-${Math.random().toString(36).slice(2, 8)}`,
		remoteJid: _groupId,
		fromMe: true,
	}))
	const react = mock(async (_groupId: string, _key: IncomingGroupMessage['key'], _emoji: string) => undefined)
	const engine = new QuizEngine(
		{ sendText, sendImageWithCaption, react },
		{
			sleep,
			...(opts?.seasonStore ? { seasonStore: opts.seasonStore } : {}),
			...(opts?.onFinished ? { onFinished: opts.onFinished } : {}),
		},
	)
	return { engine, sendText, sendImageWithCaption, react, sleep }
}

function isWinnerMessageCall(
	call: unknown,
): call is [string, string, { quotedKey?: IncomingGroupMessage['key'] }?] {
	if (!Array.isArray(call)) return false
	if (call.length < 2) return false
	return typeof call[1] === 'string' && call[1].includes('せいかいだった')
}

describe('QuizEngine behavior', () => {
	test('ignores PN-only incoming when senderLid is missing', async () => {
		const { engine, sendText, react } = createEngine()
		await engine.run(makeSingleQuestionBundle(), [makeMember({ lid: '628111@lid', pn: '628111' })], '120@g.us', {
			noCooldown: true,
		})

		await engine.onIncomingMessage(makeIncoming({ senderLid: null, senderNumber: '628111', text: 'abc' }))

		// Only intro + question, no winner/reaction for PN-only identity
		expect(sendText.mock.calls.length).toBe(2)
		expect(react.mock.calls.length).toBe(0)
	})

	test('cooldown warning is only sent once per question', async () => {
		const { engine, sendText, react } = createEngine()
		await engine.run(makeBundle(), [makeMember()], '120@g.us')

		await engine.onIncomingMessage(makeIncoming()) // first correct to activate cooldown
		const beforeCount = sendText.mock.calls.length

		await engine.onIncomingMessage(makeIncoming({ key: { id: 'MSG-2', remoteJid: '120@g.us' } }))
		await engine.onIncomingMessage(makeIncoming({ key: { id: 'MSG-3', remoteJid: '120@g.us' } }))

		const warningCalls = sendText.mock.calls
			.slice(beforeCount)
			.filter((call) => call.length > 1 && String(call[1]).startsWith('Baru bisa jawab lagi mulai '))
		expect(warningCalls.length).toBe(1)
		expect(String(warningCalls[0]?.[1])).not.toContain(':')
		expect(react.mock.calls.length).toBeGreaterThan(0)
	})

	test('filters answers ending with symbols', async () => {
		const { engine, sendText, react } = createEngine()
		await engine.run(makeBundle(), [makeMember()], '120@g.us', { noCooldown: true })

		await engine.onIncomingMessage(makeIncoming({ text: 'abc.' }))

		// only intro + question messages should exist, no reactions/winner
		expect(sendText.mock.calls.length).toBe(2)
		expect(react.mock.calls.length).toBe(0)
	})

	test('accepts Katakana long vowel mark at answer end', async () => {
		const { engine, sendText, react } = createEngine()
		await engine.run(makeSingleQuestionLongVowelBundle(), [makeMember()], '120@g.us', { noCooldown: true })

		await engine.onIncomingMessage(makeIncoming({ text: 'スーパー', key: { id: 'MSG-LONG', remoteJid: '120@g.us' } }))

		expect(react.mock.calls.length).toBeGreaterThan(0)
		const winnerCall = sendText.mock.calls.find((call) => isWinnerMessageCall(call))
		expect(winnerCall).toBeTruthy()
	})

	test('winner message quotes correct answer key', async () => {
		const { engine, sendText } = createEngine()
		await engine.run(makeBundle(), [makeMember()], '120@g.us', { noCooldown: true })

		const incoming = makeIncoming({
			key: { id: 'MSG-WIN', remoteJid: '120@g.us', participant: '628111@s.whatsapp.net' },
		})
		await engine.onIncomingMessage(incoming)

		const winnerCall = sendText.mock.calls.find((call) => isWinnerMessageCall(call))
		expect(winnerCall).toBeTruthy()
		if (!winnerCall) throw new Error('winner message call not found')
		expect(winnerCall[2]).toMatchObject({ quotedKey: incoming.key })
	})

	test('stopCurrentQuiz toggles running state', async () => {
		const { engine } = createEngine()
		await engine.run(makeBundle(), [makeMember()], '120@g.us', { noCooldown: true })
		expect(engine.isRunning()).toBe(true)
		expect(engine.stopCurrentQuiz()).toBe(true)
		expect(engine.isRunning()).toBe(false)
		expect(engine.stopCurrentQuiz()).toBe(false)
	})

	test('run resolves before completion but onFinished fires only when quiz ends', async () => {
		const onFinished = mock(() => undefined)
		const { engine } = createEngine({ onFinished })

		await engine.run(makeSingleQuestionBundle(), [makeMember()], '120@g.us', { noCooldown: true })

		// run() has resolved, but question is still active
		expect(engine.isRunning()).toBe(true)
		expect(onFinished.mock.calls.length).toBe(0)

		await engine.onIncomingMessage(makeIncoming({ text: 'abc', key: { id: 'MSG-FINISH', remoteJid: '120@g.us' } }))

		expect(engine.isRunning()).toBe(false)
		expect(onFinished.mock.calls.length).toBe(1)
	})

	test('stopCurrentQuizWithFinal returns false when inactive', async () => {
		const { engine } = createEngine()
		expect(await engine.stopCurrentQuizWithFinal()).toBe(false)
	})

	test('stopCurrentQuizWithFinal sends final scoreboard when active', async () => {
		const { engine, sendText } = createEngine()
		await engine.run(makeBundle(), [makeMember()], '120@g.us', { noCooldown: true })
		expect(engine.isRunning()).toBe(true)

		// Answer Q1 so we have points on the board
		await engine.onIncomingMessage(makeIncoming({
			text: 'abc',
			key: { id: 'MSG-WIN-FINAL', remoteJid: '120@g.us', participant: '628111@s.whatsapp.net' },
		}))

		const result = await engine.stopCurrentQuizWithFinal()
		expect(result).toBe(true)
		expect(engine.isRunning()).toBe(false)

		// Should have a final scoreboard message
		const finalCall = sendText.mock.calls.find((call) =>
			Array.isArray(call) && call.length > 1 && String(call[1]).includes('🏁 *はやくこたえて！ END*')
		)
		expect(finalCall).toBeTruthy()
	})

	test('stopCurrentQuizWithFinal clears all timers and stops accepting answers', async () => {
		const now = Date.now()
		const bundle: QuizBundle = {
			directory: '/tmp/quiz',
			introAt: new Date(now),
			startAt: new Date(now),
			rounds: [{ emoji: '🌟', startAt: new Date(now), questions: makeSingleQuestionBundle().questions }],
			introNote: null,
			outroNote: null,
			messageTemplates: {},
			questions: makeSingleQuestionBundle().questions,
		}

		const { engine, sendText } = createEngine()
		await engine.run(bundle, [makeMember()], '120@g.us', { noCooldown: true })

		// Stop with final immediately
		const result = await engine.stopCurrentQuizWithFinal()
		expect(result).toBe(true)
		expect(engine.isRunning()).toBe(false)

		// After stopping, incoming answers should be ignored (no more reactions/sends)
		const countBefore = sendText.mock.calls.length
		await engine.onIncomingMessage(makeIncoming({ text: 'abc', key: { id: 'MSG-AFTER-STOP', remoteJid: '120@g.us' } }))
		expect(sendText.mock.calls.length).toBe(countBefore)
	})

	test('caps normal stage per-question total to 10 even after wrong attempts', async () => {
		const { engine, sendText } = createEngine()
		await engine.run(makeSingleQuestionBundle(), [makeMember()], '120@g.us', { noCooldown: true })

		await engine.onIncomingMessage(makeIncoming({ text: 'no' }))
		await engine.onIncomingMessage(makeIncoming({ text: 'nah' }))
		await engine.onIncomingMessage(makeIncoming({ text: 'abc', key: { id: 'MSG-WIN-CAP', remoteJid: '120@g.us' } }))

		const finalCall = sendText.mock.calls.find((call) =>
			Array.isArray(call) && call.length > 1 && String(call[1]).includes('🏁 *はやくこたえて！ END*')
		)
		expect(finalCall).toBeTruthy()
		if (!finalCall) throw new Error('final scoreboard not found')
		const text = String(finalCall[1])
		expect(text).toContain('+10 pts')
	})

	test('special stage sends announcement before question', async () => {
		const { engine, sendText } = createEngine()
		await engine.run(makeBundleWithSpecial(), [makeMember()], '120@g.us', { noCooldown: true })

		await engine.onIncomingMessage(makeIncoming({ text: 'abc', key: { id: 'MSG-NEXT', remoteJid: '120@g.us' } }))

		const texts = sendText.mock.calls.map((call) => (call.length > 1 ? String(call[1]) : ''))
		const announcementIndex = texts.findIndex((text) => text.includes('神のステージ'))
		const specialQuestionIndex = texts.findIndex((text) => text.includes('Q99'))

		expect(announcementIndex).toBeGreaterThan(-1)
		expect(specialQuestionIndex).toBeGreaterThan(announcementIndex)
	})

	test('kanji correct answer uses 🌸 reaction, perfect header, and +2 bonus points', async () => {
		const { engine, sendText, react } = createEngine()
		await engine.run(makeSingleQuestionKanjiBundle(), [makeMember()], '120@g.us', { noCooldown: true })

		await engine.onIncomingMessage(makeIncoming({ text: '漢字', key: { id: 'MSG-KANJI', remoteJid: '120@g.us' } }))

		const reactionCall = react.mock.calls.find((call) => Array.isArray(call) && call[2] === '🌸')
		expect(reactionCall).toBeTruthy()

		const perfectWinnerCall = sendText.mock.calls.find((call) =>
			Array.isArray(call) && call.length > 1 && String(call[1]).includes('🤩 *かんぺきだった！*')
			&& String(call[1]).includes('_+12pts_')
		)
		expect(perfectWinnerCall).toBeTruthy()

		const finalCall = sendText.mock.calls.find((call) =>
			Array.isArray(call) && call.length > 1 && String(call[1]).includes('🏁 *はやくこたえて！ END*')
		)
		expect(finalCall).toBeTruthy()
		if (!finalCall) throw new Error('final scoreboard not found')
		expect(String(finalCall[1])).toContain('+12 pts')
	})

	test('sends 10-minute warning as reply to question before timeout', async () => {
		const now = Date.now()
		const bundle: QuizBundle = {
			directory: '/tmp/quiz',
			introAt: new Date(now),
			startAt: new Date(now),
			rounds: [],
			introNote: null,
			outroNote: null,
			messageTemplates: {},
			questions: [
				{
					number: 1,
					text: 'Q1',
					answers: ['abc'],
					explanation: '',
					imagePath: null,
					isSpecialStage: false,
				},
			],
		}
		bundle.rounds = [{ emoji: '🌟', startAt: bundle.startAt, questions: bundle.questions }]

		const timers: Array<{ ms: number; fn: () => void | Promise<void> }> = []
		const originalSetTimeout = globalThis.setTimeout
		const originalClearTimeout = globalThis.clearTimeout
		globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
			const runner = () => fn()
			timers.push({ ms: Number(ms ?? 0), fn: runner })
			return {
				ref() {
					return this
				},
				unref() {
					return this
				},
			} as unknown as ReturnType<typeof setTimeout>
		}) as typeof setTimeout
		globalThis.clearTimeout = ((_timer: ReturnType<typeof setTimeout>) => undefined) as typeof clearTimeout

		try {
			const { engine, sendText } = createEngine()
			await engine.run(bundle, [makeMember()], '120@g.us', { noCooldown: true })

			const warningTimer = timers.find((entry) => entry.ms === 50 * 60 * 1000)
			expect(warningTimer).toBeTruthy()
			if (!warningTimer) throw new Error('warning timer not found')
			await warningTimer.fn()

			const warningCall = sendText.mock.calls.find((call) =>
				Array.isArray(call) && call.length > 1 && String(call[1]) === '⏰ Tinggal 10 menit lagi!'
			)
			expect(warningCall).toBeTruthy()
			if (!warningCall) throw new Error('warning message call not found')
			expect(warningCall[2]).toMatchObject({
				quotedKey: expect.objectContaining({ remoteJid: '120@g.us', fromMe: true }),
			})
		} finally {
			globalThis.setTimeout = originalSetTimeout
			globalThis.clearTimeout = originalClearTimeout
		}
	})

	test('timeout message replies to question message', async () => {
		const now = Date.now()
		const bundle: QuizBundle = {
			directory: '/tmp/quiz',
			introAt: new Date(now),
			startAt: new Date(now),
			rounds: [],
			introNote: null,
			outroNote: null,
			messageTemplates: {},
			questions: [
				{
					number: 1,
					text: 'Q1',
					answers: ['abc'],
					explanation: '',
					imagePath: null,
					isSpecialStage: false,
				},
			],
		}
		bundle.rounds = [{ emoji: '🌟', startAt: bundle.startAt, questions: bundle.questions }]

		const timers: Array<{ ms: number; fn: () => void | Promise<void> }> = []
		const originalSetTimeout = globalThis.setTimeout
		const originalClearTimeout = globalThis.clearTimeout
		globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
			const runner = () => fn()
			timers.push({ ms: Number(ms ?? 0), fn: runner })
			return {
				ref() {
					return this
				},
				unref() {
					return this
				},
			} as unknown as ReturnType<typeof setTimeout>
		}) as typeof setTimeout
		globalThis.clearTimeout = ((_timer: ReturnType<typeof setTimeout>) => undefined) as typeof clearTimeout

		try {
			const { engine, sendText } = createEngine()
			await engine.run(bundle, [makeMember()], '120@g.us', { noCooldown: true })

			const timeoutTimer = timers.find((entry) => entry.ms === 60 * 60 * 1000)
			expect(timeoutTimer).toBeTruthy()
			if (!timeoutTimer) throw new Error('timeout timer not found')
			await timeoutTimer.fn()

			const timeoutCall = sendText.mock.calls.find((call) =>
				Array.isArray(call) && call.length > 1 && String(call[1]).startsWith('⏱️ Waktu habis untuk soal ini.')
			)
			expect(timeoutCall).toBeTruthy()
			if (!timeoutCall) throw new Error('timeout message call not found')
			expect(timeoutCall[2]).toMatchObject({
				quotedKey: expect.objectContaining({ remoteJid: '120@g.us', fromMe: true }),
			})
		} finally {
			globalThis.setTimeout = originalSetTimeout
			globalThis.clearTimeout = originalClearTimeout
		}
	})

	test('sends between-round notice before next round starts', async () => {
		const now = new Date('2026-04-04T08:00:00+07:00').getTime()
		const round1Question: QuizBundle['questions'][number] = {
			number: 1,
			text: 'Q1',
			answers: ['aa'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		}
		const round2Question: QuizBundle['questions'][number] = {
			number: 2,
			text: 'Q2',
			answers: ['bb'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		}
		const bundle: QuizBundle = {
			directory: '/tmp/quiz',
			introAt: new Date(now),
			startAt: new Date(now),
			rounds: [
				{ emoji: '🌅', startAt: new Date(now), questions: [round1Question] },
				{ emoji: '🌆', startAt: new Date('2026-04-04T15:00:00+07:00'), questions: [round2Question] },
			],
			introNote: null,
			outroNote: null,
			messageTemplates: {},
			questions: [round1Question, round2Question],
		}

		const { engine, sendText } = createEngine()
		await engine.run(bundle, [makeMember()], '120@g.us', { noCooldown: true })
		await engine.onIncomingMessage(makeIncoming({ text: 'aa', key: { id: 'ROUND-1', remoteJid: '120@g.us' } }))

		const noticeCall = sendText.mock.calls.find((call) =>
			Array.isArray(call) && String(call[1]).includes('Ronde berikutnya mulai pukul')
		)
		expect(noticeCall).toBeTruthy()
		const noticeText = String(noticeCall?.[1] ?? '')
		expect(noticeText).toContain('15.00 WIB')
		expect(noticeText).toContain('☕ *はやくこたえて！ BREAK*')
		expect(noticeText).toContain('🐻 * _gao gao, gao!_ *')
		expect(noticeText).not.toContain('Hasil perolehan poin akan diumumkan besok pagi. Sampai jumpa besok!')
		expect(noticeText.indexOf('☕ *はやくこたえて！ BREAK*')).toBeLessThan(
			noticeText.indexOf('Ronde berikutnya mulai pukul'),
		)
	})

	test('second round question progress is global (e.g. 3/5)', async () => {
		const now = Date.now()
		const q1: QuizBundle['questions'][number] = {
			number: 1,
			text: 'Q1',
			answers: ['aaa'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		}
		const q2: QuizBundle['questions'][number] = {
			number: 2,
			text: 'Q2',
			answers: ['bbb'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		}
		const q3: QuizBundle['questions'][number] = {
			number: 3,
			text: 'Q3',
			answers: ['ccc'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		}
		const q4: QuizBundle['questions'][number] = {
			number: 4,
			text: 'Q4',
			answers: ['ddd'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		}
		const q5: QuizBundle['questions'][number] = {
			number: 5,
			text: 'Q5',
			answers: ['eee'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		}

		const bundle: QuizBundle = {
			directory: '/tmp/quiz',
			introAt: new Date(now),
			startAt: new Date(now),
			rounds: [
				{ emoji: '🌅', startAt: new Date(now), questions: [q1, q2] },
				{ emoji: '🌆', startAt: new Date(now), questions: [q3, q4, q5] },
			],
			introNote: null,
			outroNote: null,
			messageTemplates: {},
			questions: [q1, q2, q3, q4, q5],
		}

		const { engine, sendText } = createEngine()
		await engine.run(bundle, [makeMember()], '120@g.us', { noCooldown: true })
		await engine.onIncomingMessage(makeIncoming({ text: 'aaa', key: { id: 'R1-1', remoteJid: '120@g.us' } }))
		await engine.onIncomingMessage(makeIncoming({ text: 'bbb', key: { id: 'R1-2', remoteJid: '120@g.us' } }))

		const q3Call = sendText.mock.calls.find((call) => Array.isArray(call) && String(call[1]).includes('\n\nQ3\n\n'))
		expect(q3Call).toBeTruthy()
		expect(String(q3Call?.[1] ?? '')).toContain('(3/5)')
	})

	test('starts scheduled next round after timer elapses', async () => {
		const now = Date.now()
		const q1: QuizBundle['questions'][number] = {
			number: 1,
			text: 'Q1',
			answers: ['aa'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		}
		const q2: QuizBundle['questions'][number] = {
			number: 2,
			text: 'Q2',
			answers: ['bb'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		}
		const bundle: QuizBundle = {
			directory: '/tmp/quiz',
			introAt: new Date(now),
			startAt: new Date(now),
			rounds: [
				{ emoji: '🌅', startAt: new Date(now), questions: [q1] },
				{ emoji: '🌆', startAt: new Date(now + 60_000), questions: [q2] },
			],
			introNote: null,
			outroNote: null,
			messageTemplates: {},
			questions: [q1, q2],
		}

		const timers: Array<{ ms: number; fn: () => void | Promise<void> }> = []
		const originalSetTimeout = globalThis.setTimeout
		const originalClearTimeout = globalThis.clearTimeout
		globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
			const runner = () => fn()
			timers.push({ ms: Number(ms ?? 0), fn: runner })
			return {
				ref() {
					return this
				},
				unref() {
					return this
				},
			} as unknown as ReturnType<typeof setTimeout>
		}) as typeof setTimeout
		globalThis.clearTimeout = ((_timer: ReturnType<typeof setTimeout>) => undefined) as typeof clearTimeout

		try {
			const { engine, sendText } = createEngine()
			await engine.run(bundle, [makeMember()], '120@g.us', { noCooldown: true })
			await engine.onIncomingMessage(makeIncoming({ text: 'aa', key: { id: 'ROUND-TIMER', remoteJid: '120@g.us' } }))

			const roundStartTimer = timers.find((entry) => entry.ms > 0 && entry.ms < 5 * 60 * 1000)
			expect(roundStartTimer).toBeTruthy()
			if (!roundStartTimer) throw new Error('next round timer not found')
			await roundStartTimer.fn()

			const q2Call = sendText.mock.calls.find((call) => Array.isArray(call) && String(call[1]).includes('\n\nQ2\n\n'))
			expect(q2Call).toBeTruthy()
		} finally {
			globalThis.setTimeout = originalSetTimeout
			globalThis.clearTimeout = originalClearTimeout
		}
	})

	test('sends BREAK scoreboard with next-round notice at bottom', async () => {
		const now = new Date('2026-04-04T08:00:00+07:00').getTime()
		const round1Question: QuizBundle['questions'][number] = {
			number: 1,
			text: 'Q1',
			answers: ['aa'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		}
		const round2Question: QuizBundle['questions'][number] = {
			number: 2,
			text: 'Q2',
			answers: ['bb'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		}
		const bundle: QuizBundle = {
			directory: '/tmp/quiz',
			introAt: new Date(now),
			startAt: new Date(now),
			rounds: [
				{ emoji: '🌅', startAt: new Date(now), questions: [round1Question] },
				{ emoji: '🌆', startAt: new Date('2026-04-04T15:00:00+07:00'), questions: [round2Question] },
			],
			introNote: null,
			outroNote: null,
			messageTemplates: {},
			questions: [round1Question, round2Question],
		}

		const { engine, sendText } = createEngine()
		await engine.run(bundle, [makeMember()], '120@g.us', { noCooldown: true })
		await engine.onIncomingMessage(makeIncoming({ text: 'aa', key: { id: 'ROUND-END', remoteJid: '120@g.us' } }))

		const texts = sendText.mock.calls.map((call) => String(call[1] ?? ''))
		const breakIndex = texts.findIndex((text) => text.includes('BREAK'))
		const noticeIndex = texts.findIndex((text) => text.includes('Ronde berikutnya mulai pukul'))

		expect(breakIndex).toBeGreaterThan(-1)
		expect(noticeIndex).toBeGreaterThan(-1)
		expect(noticeIndex).toBe(breakIndex)
		const breakText = texts[breakIndex] ?? ''
		expect(breakText.indexOf('☕ *はやくこたえて！ BREAK*')).toBeLessThan(
			breakText.indexOf('Ronde berikutnya mulai pukul'),
		)
		expect(breakText).not.toContain('Hasil perolehan poin akan diumumkan besok pagi. Sampai jumpa besok!')
	})
})

// ---------------------------------------------------------------------------
// Season-related tests
// ---------------------------------------------------------------------------

const seasonTestDirs: string[] = []

afterEach(async () => {
	while (seasonTestDirs.length > 0) {
		const dir = seasonTestDirs.pop()
		if (!dir) continue
		await rm(dir, { recursive: true, force: true })
	}
})

function makeSeasonStore(): SeasonStore {
	const dir = join(tmpdir(), `kotaete-season-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
	seasonTestDirs.push(dir)
	return new SeasonStore(join(dir, 'season-points.json'))
}

function makeBundleWithSeason(
	season?: { start?: boolean; end?: boolean; caption?: string; scoreboardTemplate?: string },
): QuizBundle {
	const now = Date.now()
	const questions = [
		{
			number: 1,
			text: 'Q1',
			answers: ['abc'],
			explanation: '',
			imagePath: null,
			isSpecialStage: false,
		},
	]
	return {
		directory: '/tmp/quiz',
		introAt: new Date(now),
		startAt: new Date(now),
		rounds: [{ emoji: '🌟', startAt: new Date(now), questions }],
		introNote: null,
		outroNote: null,
		messageTemplates: {},
		questions,
		// When season is provided (even without start/end), it enables accumulation
		season: season !== undefined ? { ...season } : { start: false, end: false },
	}
}

describe('season accumulation behavior', () => {
	test('season start resets accumulated points before accumulating', async () => {
		const store = makeSeasonStore()
		const members = [
			makeMember({ pn: '628111', kananame: 'アリ', nickname: 'Ari', classgroup: '10B' }),
		]

		// Pre-populate some points
		await store.setGroupMembers('120@g.us', members)
		await store.addPoints('120@g.us', members, new Map([['628111@lid', 50]]))
		expect(store.getPoints('120@g.us').get('628111@lid')).toBe(50)

		const { engine } = createEngine({ seasonStore: store })
		await engine.run(makeBundleWithSeason({ start: true }), members, '120@g.us', { noCooldown: true })
		await engine.onIncomingMessage(makeIncoming({ text: 'abc', key: { id: 'S-START', remoteJid: '120@g.us' } }))
		await engine.stopCurrentQuizWithFinal()

		// After season start, points should be reset + quiz points only (10)
		const points = store.getPoints('120@g.us').get('628111@lid')
		expect(points).toBe(10)
	})

	test('season points accumulate across quizzes', async () => {
		const store = makeSeasonStore()
		const members = [makeMember({ pn: '628111' })]

		// Quiz 1: accumulate 10 points
		const { engine: engine1 } = createEngine({ seasonStore: store })
		await engine1.run(makeBundleWithSeason(), members, '120@g.us', { noCooldown: true })
		await engine1.onIncomingMessage(makeIncoming({ text: 'abc', key: { id: 'S-1', remoteJid: '120@g.us' } }))
		await engine1.stopCurrentQuizWithFinal()

		// Quiz 2: accumulate another 10 points
		const { engine: engine2 } = createEngine({ seasonStore: store })
		await engine2.run(makeBundleWithSeason(), members, '120@g.us', { noCooldown: true })
		await engine2.onIncomingMessage(makeIncoming({ text: 'abc', key: { id: 'S-2', remoteJid: '120@g.us' } }))
		await engine2.stopCurrentQuizWithFinal()

		expect(store.getPoints('120@g.us').get('628111@lid')).toBe(20)
		expect(store.getPoints('120@g.us').get('628111@lid') ?? 0).toBe(20)
	})

	test('season end sends image+caption first and sends others message when >3 participants', async () => {
		const store = makeSeasonStore()
		const members = [
			makeMember({ pn: '628111', kananame: 'アリ', nickname: 'Ari', classgroup: '10B' }),
			makeMember({ lid: '628222@lid', pn: '628222', kananame: 'バニャ', nickname: 'Vanya', classgroup: '8B' }),
			makeMember({ lid: '628333@lid', pn: '628333', kananame: 'ナディラ', nickname: 'Nadhila', classgroup: '10C' }),
			makeMember({ lid: '628444@lid', pn: '628444', kananame: 'ララ', nickname: 'Rara', classgroup: '7B' }),
		]

		// Pre-accumulate points so we have varied scores
		await store.setGroupMembers('120@g.us', members)
		await store.addPoints(
			'120@g.us',
			members,
			new Map([
				['628111@lid', 40],
				['628222@lid', 50],
				['628333@lid', 30],
				['628444@lid', 10],
			]),
		)

		const { engine, sendText, sendImageWithCaption } = createEngine({ seasonStore: store })
		await engine.run(makeBundleWithSeason({ end: true, caption: 'Final Week' }), members, '120@g.us', {
			noCooldown: true,
		})
		await engine.onIncomingMessage(makeIncoming({ text: 'abc', key: { id: 'S-END', remoteJid: '120@g.us' } }))
		await engine.stopCurrentQuizWithFinal()

		// First special season message should be an image+caption (sendImageWithCaption)
		expect(sendImageWithCaption.mock.calls.length).toBeGreaterThanOrEqual(1)
		const imgCall = sendImageWithCaption.mock.calls.find((call) =>
			String(call[2]).includes('🏆 *Hasil NIPBANG Kotaete!*')
		)
		expect(imgCall).toBeTruthy()
		expect(String(imgCall?.[2] ?? '')).toContain('_Final Week_')
		expect(String(imgCall?.[2] ?? '')).toContain('🥇')

		// Second special season message should be others text when there are participants beyond top 3
		const texts = sendText.mock.calls.map((call) => String(call[1] ?? ''))
		const othersMessage = texts.find((text) => text.includes('Selamat juga kepada partisipan lainnya!'))
		expect(othersMessage).toBeTruthy()
		expect(othersMessage).toContain('ララ')

		// Points should be reset after season end
		expect(store.getPoints('120@g.us').get('628222@lid')).toBe(50)
	})

	test('season end with <=3 participants does not send others message', async () => {
		const store = makeSeasonStore()
		const members = [
			makeMember({ pn: '628111', kananame: 'アリ', nickname: 'Ari', classgroup: '10B' }),
			makeMember({ lid: '628222@lid', pn: '628222', kananame: 'バニャ', nickname: 'Vanya', classgroup: '8B' }),
		]

		await store.setGroupMembers('120@g.us', members)
		await store.addPoints(
			'120@g.us',
			members,
			new Map([
				['628111@lid', 40],
				['628222@lid', 50],
			]),
		)

		const { engine, sendText, sendImageWithCaption } = createEngine({ seasonStore: store })
		await engine.run(makeBundleWithSeason({ end: true, caption: 'Short Season' }), members, '120@g.us', {
			noCooldown: true,
		})
		await engine.onIncomingMessage(makeIncoming({ text: 'abc', key: { id: 'S-END-SHORT', remoteJid: '120@g.us' } }))
		await engine.stopCurrentQuizWithFinal()

		// Should still send image with caption
		expect(sendImageWithCaption.mock.calls.length).toBeGreaterThanOrEqual(1)
		const imgCall = sendImageWithCaption.mock.calls.find((call) =>
			String(call[2]).includes('🏆 *Hasil NIPBANG Kotaete!*')
		)
		expect(imgCall).toBeTruthy()

		// Should not send others message with <=3 participants
		const texts = sendText.mock.calls.map((call) => String(call[1] ?? ''))
		const othersMessage = texts.find((text) => text.includes('Selamat juga kepada partisipan lainnya!'))
		expect(othersMessage).toBeFalsy()

		// Points should be reset after season end
		expect(store.getPoints('120@g.us').get('628222@lid')).toBe(50)
	})

	test('no season messages when season config is absent', async () => {
		const store = makeSeasonStore()
		const members = [makeMember()]

		// Use a bundle with season: null explicitly
		const now = Date.now()
		const noSeasonBundle: QuizBundle = {
			directory: '/tmp/quiz',
			introAt: new Date(now),
			startAt: new Date(now),
			rounds: [{ emoji: '🌟', startAt: new Date(now), questions: makeBundleWithSeason().questions }],
			introNote: null,
			outroNote: null,
			messageTemplates: {},
			questions: makeBundleWithSeason().questions,
			season: null,
		}

		const { engine, sendText } = createEngine({ seasonStore: store })
		await engine.run(noSeasonBundle, members, '120@g.us', { noCooldown: true })
		await engine.onIncomingMessage(makeIncoming({ text: 'abc', key: { id: 'S-NO', remoteJid: '120@g.us' } }))
		await engine.stopCurrentQuizWithFinal()

		const texts = sendText.mock.calls.map((call) => String(call[1] ?? ''))
		expect(texts.find((text) => text.includes('🏆 *Hasil NIPBANG Kotaete!*'))).toBeFalsy()
	})
})
