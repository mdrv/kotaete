import { describe, expect, mock, test } from 'bun:test'
import type { IncomingGroupMessage, NMember, QuizBundle } from '../types.ts'
import type { SendTextOptions } from '../whatsapp/types.ts'
import { QuizEngine } from './engine.ts'

function makeBundle(): QuizBundle {
	const now = Date.now()
	return {
		directory: '/tmp/quiz',
		introAt: new Date(now),
		startAt: new Date(now),
		introNote: null,
		outroNote: null,
		questions: [
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
		],
	}
}

function makeBundleWithSpecial(): QuizBundle {
	const now = Date.now()
	return {
		directory: '/tmp/quiz',
		introAt: new Date(now),
		startAt: new Date(now),
		introNote: null,
		outroNote: null,
		questions: [
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
		],
	}
}

function makeSingleQuestionBundle(): QuizBundle {
	const now = Date.now()
	return {
		directory: '/tmp/quiz',
		introAt: new Date(now),
		startAt: new Date(now),
		introNote: null,
		outroNote: null,
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
}

function makeMember(): NMember {
	return {
		mid: '1',
		kananame: 'User',
		nickname: 'User',
		classgroup: 'A',
		number: '628111',
	}
}

function makeIncoming(overrides?: Partial<IncomingGroupMessage>): IncomingGroupMessage {
	return {
		groupId: '120@g.us',
		senderRawJid: '628111@s.whatsapp.net',
		senderNumber: '628111',
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

function createEngine() {
	const sleep = mock(async (_ms: number) => undefined)
	const sendText = mock(async (_groupId: string, _text: string, _opts?: SendTextOptions) => undefined)
	const sendImageWithCaption = mock(async (_groupId: string, _imagePath: string, _caption: string) => undefined)
	const react = mock(async (_groupId: string, _key: IncomingGroupMessage['key'], _emoji: string) => undefined)
	const engine = new QuizEngine({ sendText, sendImageWithCaption, react }, { sleep })
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
		expect(react.mock.calls.length).toBeGreaterThan(0)
	})

	test('filters answers ending with symbols', async () => {
		const { engine, sendText, react } = createEngine()
		await engine.run(makeBundle(), [makeMember()], '120@g.us', { disableCooldown: true })

		await engine.onIncomingMessage(makeIncoming({ text: 'abc.' }))

		// only intro + question messages should exist, no reactions/winner
		expect(sendText.mock.calls.length).toBe(2)
		expect(react.mock.calls.length).toBe(0)
	})

	test('winner message quotes correct answer key', async () => {
		const { engine, sendText } = createEngine()
		await engine.run(makeBundle(), [makeMember()], '120@g.us', { disableCooldown: true })

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
		await engine.run(makeBundle(), [makeMember()], '120@g.us', { disableCooldown: true })
		expect(engine.isRunning()).toBe(true)
		expect(engine.stopCurrentQuiz()).toBe(true)
		expect(engine.isRunning()).toBe(false)
		expect(engine.stopCurrentQuiz()).toBe(false)
	})

	test('caps normal stage per-question total to 10 even after wrong attempts', async () => {
		const { engine, sendText } = createEngine()
		await engine.run(makeSingleQuestionBundle(), [makeMember()], '120@g.us', { disableCooldown: true })

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
		await engine.run(makeBundleWithSpecial(), [makeMember()], '120@g.us', { disableCooldown: true })

		await engine.onIncomingMessage(makeIncoming({ text: 'abc', key: { id: 'MSG-NEXT', remoteJid: '120@g.us' } }))

		const texts = sendText.mock.calls.map((call) => (call.length > 1 ? String(call[1]) : ''))
		const announcementIndex = texts.findIndex((text) => text.includes('神のステージ'))
		const specialQuestionIndex = texts.findIndex((text) => text.includes('Q99'))

		expect(announcementIndex).toBeGreaterThan(-1)
		expect(specialQuestionIndex).toBeGreaterThan(announcementIndex)
	})
})
