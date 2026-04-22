import type { ToolDef } from './types.ts'

export function buildSearchTools(webSearch: boolean): ToolDef[] {
	if (!webSearch) return []
	return [
		{
			type: 'function' as const,
			function: {
				name: 'web_search',
				description:
					'Search the web for current information. Use when you need up-to-date facts, news, translations, or information you may not have in your training data. Always search when the user asks about recent events or current information.',
				parameters: {
					type: 'object',
					properties: {
						query: {
							type: 'string',
							description: 'The search query string',
						},
					},
					required: ['query'],
				},
			},
		},
		{
			type: 'function' as const,
			function: {
				name: 'image_search',
				description:
					'Search for images on the web. Use when the user asks to see, show, or find a picture, photo, or visual content. The image will be sent to the user automatically as a separate message. Do NOT include image markdown or image URLs in your text response - just describe the image in your answer.',
				parameters: {
					type: 'object',
					properties: {
						query: {
							type: 'string',
							description: 'The image search query',
						},
					},
					required: ['query'],
				},
			},
		},
	]
}

export const readFileTool: ToolDef = {
	type: 'function' as const,
	function: {
		name: 'read_file',
		description:
			'Read the contents of a file. Use when the system prompt or conversation references a file path that you need to read for additional context. The path is relative to the configured base directory.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Path to the file, relative to the base directory',
				},
			},
			required: ['path'],
		},
	},
}

export const getMemberInfoTool: ToolDef = {
	type: 'function' as const,
	function: {
		name: 'get_member_info',
		description:
			'Look up detailed information about a group member by their mid (member ID, e.g. "pb25vanya"). The mid is included in the message prefix like [nickname (mid)]. Returns their kananame, class/group, and other available details. Use when you need to know more about who you are talking to or who someone mentioned.',
		parameters: {
			type: 'object',
			properties: {
				mid: {
					type: 'string',
					description: 'The member ID (mid) to look up, e.g. "pb25vanya"',
				},
			},
			required: ['mid'],
		},
	},
}
