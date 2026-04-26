import type { QuizTunables } from '../types.ts'

export function awardCorrectPoints(
	tunables: QuizTunables,
	currentPointsForQuestion: number,
	isSpecialStage: boolean,
): number {
	if (isSpecialStage) return tunables.points.special
	return Math.max(0, tunables.points.normalCap - currentPointsForQuestion)
}

export function awardWrongPoints(tunables: QuizTunables, isSpecialStage: boolean): number {
	if (isSpecialStage) return 0
	return tunables.points.perWrong
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
