import { POINTS_NORMAL_CAP, POINTS_PER_WRONG_ANSWER, POINTS_SPECIAL } from '../constants.ts'

export function awardCorrectPoints(currentPointsForQuestion: number, isSpecialStage: boolean): number {
	if (isSpecialStage) return POINTS_SPECIAL
	return Math.max(0, POINTS_NORMAL_CAP - currentPointsForQuestion)
}

export function awardWrongPoints(isSpecialStage: boolean): number {
	if (isSpecialStage) return 0
	return POINTS_PER_WRONG_ANSWER
}

export function rankScores(
	pointsByNumber: Map<string, number>,
): Array<{ number: string; points: number }> {
	const entries = Array.from(pointsByNumber.entries()).map(
		([number, points]) => ({ number, points }),
	)

	entries.sort((a, b) => {
		if (b.points !== a.points) return b.points - a.points
		return a.number.localeCompare(b.number)
	})

	return entries
}
