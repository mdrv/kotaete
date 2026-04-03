import { describe, expect, test } from 'bun:test'
import type { QuizQuestion } from '../types.ts'
import { formatFinalScoreboard, formatIntro, formatQuestion } from './messages.ts'

describe('formatIntro date header', () => {
	test('renders Japanese weekday + Indonesian date style', () => {
		const introAt = new Date(Date.UTC(2025, 8, 26, 17, 0, 0, 0)) // 2025-09-27 00:00 WIB
		const text = formatIntro(introAt, null)
		expect(text).toContain('🗓️ *土︱27 September 2025*')
	})

	test('hides progress marker for special stage', () => {
		const question: QuizQuestion = {
			number: 99,
			text: 'Special text',
			answers: ['ans'],
			explanation: '',
			imagePath: null,
			isSpecialStage: true,
		}
		const text = formatQuestion(question, null, '23.59.59')
		expect(text).toContain('🌟 *はやくこたえて！ (GOD)*')
		expect(text).not.toContain('(1/4)')
		expect(text).not.toContain('SPECIAL')
		expect(text).toContain('⏰ 23.59.59 WIB')
	})

	test('uses outro note when provided', () => {
		const text = formatFinalScoreboard([], 'Custom outro footer', new Date(Date.UTC(2025, 8, 26, 17, 0, 0, 0)))
		expect(text).toContain('🗓️ *土︱27 September 2025*')
		expect(text).toContain('Custom outro footer')
		expect(text).not.toContain('gao gao, gao')
	})
})
