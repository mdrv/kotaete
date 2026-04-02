import { describe, expect, test } from 'bun:test'
import { awardCorrectPoints, awardWrongPoints } from './scoring.ts'

describe('quiz scoring rules', () => {
	test('normal question awards 1 point per wrong answer', () => {
		expect(awardWrongPoints(false)).toBe(1)
	})

	test('normal question correct answer is capped to total 10 points per question', () => {
		expect(awardCorrectPoints(0, false)).toBe(10)
		expect(awardCorrectPoints(2, false)).toBe(8)
		expect(awardCorrectPoints(9, false)).toBe(1)
		expect(awardCorrectPoints(10, false)).toBe(0)
		expect(awardCorrectPoints(12, false)).toBe(0)
	})

	test('special stage keeps fixed scoring behavior', () => {
		expect(awardWrongPoints(true)).toBe(0)
		expect(awardCorrectPoints(0, true)).toBe(25)
		expect(awardCorrectPoints(10, true)).toBe(25)
	})
})
