import type { KotaetePluginContext } from '../../src/plugin/types.ts'

export type Surreal = import('surrealdb').Surreal

export type MemberInfo = { primaryMid: string; nickname: string }

export type MemoryEntry = {
	role: 'user' | 'assistant'
	content: string
	ts: number
}

export type MemoryRecord = {
	id: string
	lid: string
	messages: MemoryEntry[]
	summary: string | null
	created_at: string
	updated_at: string
}

export type ParsedMinuteHourCron = {
	minutes: Set<number>
	hours: Set<number>
}

export type ToolDef = {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: {
			type: string
			properties: Record<string, { type: string; description: string }>
			required: string[]
		}
	}
}

export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000
export const DEFAULT_RATE_LIMIT_RESET_CRON = '0,30 * * * *'

export interface AskConfig {
	provider: string
	isCopilot: boolean
	systemPromptPath: string
	apiKey: string
	apiUrl: string
	model: string
	busyMessage: string
	maxMessages: number
	rateLimitResetCron: string
	adminLids: Set<string>
	memoryMaxChars: number
	memoryKeepRecent: number
	dbEndpoint: string
	dbUsername: string
	dbPassword: string
	dbNamespace: string
	dbDatabase: string
	thinkEmoji: string
	doneEmoji: string
	webSearch: boolean
	searxngConfig: ReturnType<typeof import('../../src/utils/searxng.ts').getSearXNGConfig>
	maxSearchRounds: number
	searchMaxResults: number
	fileBaseDir: string
	fileMaxSize: number
	systemPrompt: string
}

export interface AskContext {
	ctx: KotaetePluginContext
	config: AskConfig
	db: { current: Surreal | null }
	memberCache: Map<string, MemberInfo | null>
	rateLimits: Map<string, number>
	resetTimer: { current: ReturnType<typeof setTimeout> | null }
	downloadedImages: Array<{ path: string; query: string; sourceUrl: string }>
	closedMessage: { current: string | undefined }
	_parsedResetCron?: ReturnType<typeof import('./utils.ts').parseMinuteHourCron>
}
