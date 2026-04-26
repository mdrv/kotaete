import { describe, expect, test } from 'bun:test'
import { POINTS_SPECIAL, QUIZ_TUNABLES } from '../constants.ts'
import { awardCorrectPoints, awardWrongPoints } from './scoring.ts'

const tunables = {
	timeout: { ...QUIZ_TUNABLES.timeout },
	cooldown: { ...QUIZ_TUNABLES.cooldown },
	points: { ...QUIZ_TUNABLES.points },
	wrongAttempts: {
		...QUIZ_TUNABLES.wrongAttempts,
		emojiStreak: [...QUIZ_TUNABLES.wrongAttempts.emojiStreak],
	},
}

describe('quiz scoring rules', () => {
	test('normal question awards 1 point per wrong answer', () => {
		expect(awardWrongPoints(tunables, false)).toBe(1)
	})

	test('normal question correct answer is capped to total 10 points per question', () => {
		expect(awardCorrectPoints(tunables, 0, false)).toBe(10)
		expect(awardCorrectPoints(tunables, 2, false)).toBe(8)
		expect(awardCorrectPoints(tunables, 9, false)).toBe(1)
		expect(awardCorrectPoints(tunables, 10, false)).toBe(0)
		expect(awardCorrectPoints(tunables, 12, false)).toBe(0)
	})

	test('special stage keeps fixed scoring behavior', () => {
		expect(awardWrongPoints(tunables, true)).toBe(0)
		expect(awardCorrectPoints(tunables, 0, true)).toBe(POINTS_SPECIAL)
		expect(awardCorrectPoints(tunables, 10, true)).toBe(POINTS_SPECIAL)
	})
})
