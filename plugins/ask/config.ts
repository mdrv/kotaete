import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getSearXNGConfig } from '../../src/utils/searxng.ts'
import type { AskConfig } from './types.ts'

export function parseAskArgs(args: Record<string, string | undefined>): AskConfig {
	const provider = args['provider'] ?? 'zai'
	const isCopilot = provider === 'copilot'
	const systemPromptPath = args['systemPrompt'] ?? 'AGENTS.md'
	const apiKey = args['apiKey'] ?? 'c28e5e85d9714c8abfb6408353fe54a7.dG0sZUU1Jovsvyib'
	const defaultApiUrl = isCopilot ? 'https://api.githubcopilot.com' : 'https://api.z.ai/api/coding/paas/v4/'
	const apiUrl = args['apiUrl'] ?? defaultApiUrl
	const defaultModel = isCopilot ? 'gpt-4o' : 'glm-5v-turbo'
	const model = args['model'] ?? defaultModel
	const busyMessage = args['busyMessage'] ?? '🐻 Kuis sedang berjalan! Boleh tanya kalau sudah selesai, ya.'
	const maxMessages = Number(args['maxMessages'] ?? 3)
	const rateLimitResetCron = args['rateLimitResetCron'] ?? '0,30 * * * *'
	const adminLids = new Set((args['admins'] ?? '200729742577712@lid').split(',').map((s) => s.trim()).filter(Boolean))
	const memoryMaxChars = Number(args['memoryMaxChars'] ?? 4000)
	const memoryKeepRecent = Number(args['memoryKeepRecent'] ?? 6)
	const dbEndpoint = args['endpoint'] ?? 'http://localhost:596/rpc'
	const dbUsername = args['username'] ?? 'ua'
	const dbPassword = args['password'] ?? 'japan8'
	const dbNamespace = args['namespace'] ?? 'medrivia'
	const dbDatabase = args['database'] ?? 'id'
	const thinkEmoji = args['thinkEmoji'] ?? '💭'
	const doneEmoji = args['doneEmoji'] ?? '✅'
	const webSearch = args['webSearch'] !== 'false'
	const searxngConfig = getSearXNGConfig({
		baseUrl: args['searxngUrl'],
		authUsername: args['searxngUsername'],
		authPassword: args['searxngPassword'],
	})
	const maxSearchRounds = Number(args['maxSearchRounds'] ?? 3)
	const searchMaxResults = Number(args['searchMaxResults'] ?? 5)
	const fileBaseDir = resolve(args['fileBaseDir'] ?? '~/.kotaete/notes/').replace(/^~/, process.env.HOME ?? '~')
	const fileMaxSize = Number(args['fileMaxSize'] ?? 50_000)

	// Load system prompt
	const resolvedPath = resolve(systemPromptPath)
	let systemPrompt: string
	try {
		systemPrompt = readFileSync(resolvedPath, 'utf-8')
	} catch {
		throw new Error(`Cannot read system prompt file: ${resolvedPath}`)
	}

	// Inject WhatsApp formatting instruction into system prompt
	const waFormatInstruction = '\n\n[OUTPUT FORMAT]\nYou MUST format your replies for WhatsApp messaging.\n'
		+ '- Use *bold* for emphasis (asterisks).\n'
		+ '- Use _italic_ for subtle emphasis (underscores).\n'
		+ '- Use ~strikethrough~ for strikethrough.\n'
		+ '- Use ``` for code blocks.\n'
		+ '- NEVER use markdown tables, numbered headings (##), or [link](url) syntax.\n'
		+ '- Use simple line breaks and • for bullet lists.\n'
		+ '- Keep responses concise.\n'
		+ '- No HTML tags.\n'
	systemPrompt = systemPrompt + waFormatInstruction

	return {
		provider,
		isCopilot,
		systemPromptPath,
		apiKey,
		apiUrl,
		model,
		busyMessage,
		maxMessages,
		rateLimitResetCron,
		adminLids,
		memoryMaxChars,
		memoryKeepRecent,
		dbEndpoint,
		dbUsername,
		dbPassword,
		dbNamespace,
		dbDatabase,
		thinkEmoji,
		doneEmoji,
		webSearch,
		searxngConfig,
		maxSearchRounds,
		searchMaxResults,
		fileBaseDir,
		fileMaxSize,
		systemPrompt,
	}
}
