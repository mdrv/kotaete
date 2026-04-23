import { z } from 'zod'

const seasonConfigSchema = z.object({
	start: z.boolean().optional(),
	end: z.boolean().optional(),
	caption: z.string().optional(),
	scoreboardTemplate: z.string().optional(),
	id: z.string().optional(),
}).optional()

export const relayRunRequestSchema = z.object({
	type: z.literal('run-quiz'),
	sources: z.array(z.string().min(1)).min(1),
	quizDir: z.string().min(1).optional(),
	groupId: z.string().min(1).optional(),
	membersFile: z.string().min(1).optional(),
	noCooldown: z.boolean().optional(),
	noSchedule: z.boolean().optional(),
	noGeneration: z.boolean().optional(),
	saveSvg: z.boolean().optional(),
	season: seasonConfigSchema,
})

export const relayStatusRequestSchema = z.object({
	type: z.literal('quiz-status'),
})

export const relayStopRequestSchema = z.object({
	type: z.literal('quiz-stop'),
	id: z.string().optional(),
	silent: z.boolean().optional(),
})

export const relayStopSeasonRequestSchema = z.object({
	type: z.literal('season-stop'),
	groupId: z.string().min(1),
	noScoreboard: z.boolean().optional(),
})

export const relayLookupRequestSchema = z.object({
	type: z.literal('lookup-mapping'),
	direction: z.enum(['to-pn', 'to-lid']),
	value: z.string().min(1),
})

export const relayPluginEnableRequestSchema = z.object({
	type: z.literal('plugin-enable'),
	sourcePath: z.string().min(1),
	args: z.record(z.string(), z.string()).optional(),
})

export const relayPluginDisableRequestSchema = z.object({
	type: z.literal('plugin-disable'),
	name: z.string().min(1),
})

export const relayPluginListRequestSchema = z.object({
	type: z.literal('plugin-list'),
})

export const relayPluginAskRequestSchema = z.object({
	type: z.literal('plugin-ask'),
	action: z.enum(['close', 'open', 'tool']),
	message: z.string().optional(),
	tool: z.string().optional(),
	toolArgs: z.array(z.string()).optional(),
})
export const relayRequestSchema = z.discriminatedUnion('type', [
	relayRunRequestSchema,
	relayStatusRequestSchema,
	relayStopRequestSchema,
	relayStopSeasonRequestSchema,
	relayLookupRequestSchema,
	relayPluginEnableRequestSchema,
	relayPluginDisableRequestSchema,
	relayPluginListRequestSchema,
	relayPluginAskRequestSchema,
])

export type RelayRunRequest = z.infer<typeof relayRunRequestSchema>
export type RelayStatusRequest = z.infer<typeof relayStatusRequestSchema>
export type RelayStopRequest = z.infer<typeof relayStopRequestSchema>
export type RelayStopSeasonRequest = z.infer<typeof relayStopSeasonRequestSchema>
export type RelayLookupRequest = z.infer<typeof relayLookupRequestSchema>
export type RelayPluginEnableRequest = z.infer<typeof relayPluginEnableRequestSchema>
export type RelayPluginDisableRequest = z.infer<typeof relayPluginDisableRequestSchema>
export type RelayPluginListRequest = z.infer<typeof relayPluginListRequestSchema>
export type RelayPluginAskRequest = z.infer<typeof relayPluginAskRequestSchema>
export type RelayRequest = z.infer<typeof relayRequestSchema>

export const pluginStatusSchema = z.object({
	name: z.string(),
	sourcePath: z.string(),
	args: z.record(z.string(), z.string()),
	enabledAt: z.string(),
	active: z.boolean(),
	lastError: z.object({ at: z.string(), message: z.string() }).optional(),
})

export type PluginStatus = z.infer<typeof pluginStatusSchema>

export const jobStatusSchema = z.object({
	id: z.string(),
	groupId: z.string(),
	quizDir: z.string(),
	membersFile: z.string().optional().nullable(),
	noCooldown: z.boolean(),
	noGeneration: z.boolean().optional(),
	status: z.enum(['scheduled', 'running']),
	introAt: z.string().optional(),
	firstRoundAt: z.string().optional(),
	createdAt: z.string(),
	queuePosition: z.number().int().min(0).optional(),
})

export type JobStatus = z.infer<typeof jobStatusSchema>

export const relayResponseSchema = z.object({
	ok: z.boolean(),
	message: z.string(),
	jobs: z.array(jobStatusSchema).optional(),
	jobId: z.string().optional(),
	plugins: z.array(pluginStatusSchema).optional(),
	data: z.string().optional(),
})

export type RelayResponse = z.infer<typeof relayResponseSchema>
