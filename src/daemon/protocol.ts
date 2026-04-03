import { z } from 'zod'

export const relayRunRequestSchema = z.object({
	type: z.literal('run-quiz'),
	groupId: z.string().min(1),
	quizDir: z.string().min(1),
	membersFile: z.string().min(1),
	disableCooldown: z.boolean().optional(),
	noSchedule: z.boolean().optional(),
})

export const relayStatusRequestSchema = z.object({
	type: z.literal('quiz-status'),
})

export const relayStopRequestSchema = z.object({
	type: z.literal('quiz-stop'),
})

export const relayLookupRequestSchema = z.object({
	type: z.literal('lookup-mapping'),
	direction: z.enum(['to-pn', 'to-lid']),
	value: z.string().min(1),
})

export const relayRequestSchema = z.discriminatedUnion('type', [
	relayRunRequestSchema,
	relayStatusRequestSchema,
	relayStopRequestSchema,
	relayLookupRequestSchema,
])

export type RelayRunRequest = z.infer<typeof relayRunRequestSchema>
export type RelayStatusRequest = z.infer<typeof relayStatusRequestSchema>
export type RelayStopRequest = z.infer<typeof relayStopRequestSchema>
export type RelayLookupRequest = z.infer<typeof relayLookupRequestSchema>
export type RelayRequest = z.infer<typeof relayRequestSchema>

export const relayResponseSchema = z.object({
	ok: z.boolean(),
	message: z.string(),
})

export type RelayResponse = z.infer<typeof relayResponseSchema>
