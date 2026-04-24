import { z } from 'zod'

export type QuizStateCheckpoint = {
	version: 1
	updatedAt: string

	// Position tracking
	index: number
	roundIndex: number
	roundQuestionIndex: number
	acceptingAnswers: boolean
	deadlineAtMs: number
	questionSentAtMs: number

	// Accumulated scores
	pointsByMid: Record<string, number>
	scoreReachedAtByMid: Record<string, number>

	// Per-question transient state (only meaningful if acceptingAnswers)
	questionPointsByMid: Record<string, number>
	cooldowns: Record<string, number>
	wrongStreak: Record<string, number>
	attemptedSpecial: string[]
	cooldownWarningSent: string[]

	// Timer reconstruction
	warningAlreadySent: boolean

	// SurrealDB session to reuse on resume (preserves live dashboard data)
	loggerSessionId: string | null
}

export const quizStateCheckpointSchema = z.object({
	version: z.literal(1),
	updatedAt: z.string(),
	index: z.number(),
	roundIndex: z.number(),
	roundQuestionIndex: z.number(),
	acceptingAnswers: z.boolean(),
	deadlineAtMs: z.number(),
	questionSentAtMs: z.number(),
	pointsByMid: z.record(z.string(), z.number()),
	scoreReachedAtByMid: z.record(z.string(), z.number()),
	questionPointsByMid: z.record(z.string(), z.number()),
	cooldowns: z.record(z.string(), z.number()),
	wrongStreak: z.record(z.string(), z.number()),
	attemptedSpecial: z.array(z.string()),
	cooldownWarningSent: z.array(z.string()),
	warningAlreadySent: z.boolean(),
	loggerSessionId: z.string().nullable().optional().default(null),
})
