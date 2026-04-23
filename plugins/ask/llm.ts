import { copilotAutoModel } from '../../src/copilot-auto.ts'

import type { IncomingMedia } from '../../src/types.ts'
import { formatSearchResults, searxngSearch } from '../../src/utils/searxng.ts'
import { getApiHeaders, getBearerToken, getDb, loadGroupMemory, loadMemory } from './memory.ts'
import { buildAdminTools, buildSearchTools, getMemberInfoTool, readFileTool } from './tools.ts'
import type { AskContext, MemberInfo } from './types.ts'
import { buildUserContent } from './utils.ts'

// ── Download an image URL to a temp file ──────────────────────────────────

async function downloadImage(ac: AskContext, imageUrl: string, _query: string): Promise<string | null> {
	try {
		const resp = await fetch(imageUrl, {
			signal: AbortSignal.timeout(15_000),
			headers: { 'User-Agent': 'Kotaete/1.0' },
		})
		if (!resp.ok) return null
		const contentType = resp.headers.get('content-type') ?? ''
		if (!contentType.startsWith('image/')) return null
		const ext = contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg'
		const buffer = await resp.arrayBuffer()
		const tmpPath = `/tmp/kotaete-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
		const { writeFileSync } = await import('node:fs')
		writeFileSync(tmpPath, Buffer.from(buffer))
		ac.ctx.log.info(`ask: downloaded image to ${tmpPath} (${buffer.byteLength} bytes)`)
		return tmpPath
	} catch (err) {
		ac.ctx.log.warn(`ask: image download failed: ${err instanceof Error ? err.message : String(err)}`)
		return null
	}
}

// ── Execute a tool call by name ───────────────────────────────────────────

async function executeToolCall(ac: AskContext, name: string, argsJson: string, groupId?: string): Promise<string> {
	if (name === 'web_search') {
		const { query } = JSON.parse(argsJson) as { query: string }
		ac.ctx.log.info(`ask: web search: "${query}"`)
		const results = await searxngSearch(query, ac.config.searxngConfig, { maxResults: ac.config.searchMaxResults })
		return formatSearchResults(results)
	}
	if (name === 'image_search') {
		const { query } = JSON.parse(argsJson) as { query: string }
		ac.ctx.log.info(`ask: image search: "${query}"`)
		const results = await searxngSearch(query, ac.config.searxngConfig, {
			categories: 'images',
			maxResults: 3,
		})
		if (results.results.length === 0) {
			return 'No images found for this query.'
		}
		// Try downloading the first available image
		for (const r of results.results) {
			const imgUrl = r.img_src ?? r.thumbnail ?? r.url
			if (!imgUrl) continue
			const tmpPath = await downloadImage(ac, imgUrl, query)
			if (tmpPath) {
				ac.downloadedImages.push({ path: tmpPath, query, sourceUrl: r.url })
				return `Found image: "${r.title}" (${r.url}). Image downloaded and ready to send.`
			}
		}
		return 'Found image results but could not download any image.'
	}
	if (name === 'read_file') {
		const { path: filePath } = JSON.parse(argsJson) as { path: string }
		const { readFileSync: readSync } = await import('node:fs')
		const { resolve: resolvePath } = await import('node:path')
		const absPath = resolvePath(ac.config.fileBaseDir, filePath)
		// Security: ensure resolved path is within base dir
		if (!absPath.startsWith(resolvePath(ac.config.fileBaseDir))) {
			return 'Access denied: path is outside the allowed directory.'
		}
		ac.ctx.log.info(`ask: read_file: "${filePath}"`)
		try {
			const content = readSync(absPath, 'utf-8')
			if (content.length > ac.config.fileMaxSize) {
				return content.slice(0, ac.config.fileMaxSize) + `\n\n[... truncated at ${ac.config.fileMaxSize} chars]`
			}
			return content
		} catch {
			return `File not found or unreadable: ${filePath}`
		}
	}
	if (name === 'get_member_info') {
		const { mid } = JSON.parse(argsJson) as { mid: string }
		const cleanMid = mid.trim().toLowerCase()
		ac.ctx.log.info(`ask: get_member_info: "${cleanMid}"`)
		try {
			const conn = await getDb(ac)
			// Match by mid value in the mids array
			const rows = await conn.query(
				'SELECT nickname, mids, meta FROM member WHERE mids[*].value CONTAINS $mid LIMIT 1',
				{ mid: cleanMid },
			)
			const rec = ((rows as any)?.[0]?.[0]) as
				| { nickname?: string; mids?: Array<{ value: string }>; meta?: Record<string, string> }
				| undefined
			if (!rec) {
				return `No member found with mid "${cleanMid}".`
			}
			const meta = rec.meta ?? {}
			return [
				`Name: ${rec.nickname ?? 'unknown'}`,
				meta.kananame ? `Kananame: ${meta.kananame}` : null,
				meta.classgroup ? `Class: ${meta.classgroup}` : null,
			].filter(Boolean).join(', ')
		} catch (err) {
			return `Error looking up member: ${err instanceof Error ? err.message : String(err)}`
		}
	}
	// ── Admin-only tools ──────────────────────────────────────────────────────

	if (name === 'get_season_scores') {
		const gid = (JSON.parse(argsJson) as { groupId?: string }).groupId ?? groupId
		if (!gid) return 'No group context available to fetch scores.'
		ac.ctx.log.info(`ask: get_season_scores for ${gid}`)
		try {
			const scores = await ac.ctx.getSeasonScores(gid)
			if (scores.length === 0) return 'No season scores found for this group.'
			const lines = scores.map((s) => `${s.rank}. ${s.nickname} (${s.kananame}) [${s.classgroup}] — ${s.score} pts`)
			return `*Season Leaderboard*\n\n${lines.join('\n')}`
		} catch (err) {
			return `Error fetching scores: ${err instanceof Error ? err.message : String(err)}`
		}
	}

	if (name === 'search_members') {
		const { query, classgroup } = JSON.parse(argsJson) as { query?: string; classgroup?: string }
		ac.ctx.log.info(`ask: search_members query=${query} classgroup=${classgroup}`)
		try {
			const conn = await getDb(ac)
			const conditions: string[] = []
			const params: Record<string, string> = {}
			if (query) {
				conditions.push('(nickname CONTAINS $q OR meta.kananame CONTAINS $q)')
				params.q = query
			}
			if (classgroup) {
				conditions.push('meta.classgroup = $cg')
				params.cg = classgroup
			}
			if (conditions.length === 0) {
				// No filters — return all members (limited)
				const rows = await conn.query('SELECT nickname, mids, meta FROM member LIMIT 50', {})
				const recs = (rows as any)?.[0] as
					| Array<
						{ nickname?: string; mids?: Array<{ value: string; primary: boolean }>; meta?: Record<string, string> }
					>
					| undefined
				if (!recs?.length) return 'No members found.'
				return recs.map((r) => {
					const mid = r.mids?.find((m) => m.primary)?.value ?? r.mids?.[0]?.value ?? '?'
					return `${r.nickname ?? '?'} (${mid}) [${r.meta?.kananame ?? '-'}] ${r.meta?.classgroup ?? ''}`
				}).join('\n')
			}
			const whereClause = conditions.join(' AND ')
			const rows = await conn.query(`SELECT nickname, mids, meta FROM member WHERE ${whereClause} LIMIT 20`, params)
			const recs = (rows as any)?.[0] as
				| Array<{ nickname?: string; mids?: Array<{ value: string; primary: boolean }>; meta?: Record<string, string> }>
				| undefined
			if (!recs?.length) return 'No matching members found.'
			return recs.map((r) => {
				const mid = r.mids?.find((m) => m.primary)?.value ?? r.mids?.[0]?.value ?? '?'
				return `${r.nickname ?? '?'} (${mid}) [${r.meta?.kananame ?? '-'}] ${r.meta?.classgroup ?? ''}`
			}).join('\n')
		} catch (err) {
			return `Error searching members: ${err instanceof Error ? err.message : String(err)}`
		}
	}

	if (name === 'bash') {
		const { command, timeout: timeoutSec } = JSON.parse(argsJson) as { command: string; timeout?: number }
		const maxTimeout = 30
		const timeoutMs = Math.min(Math.max((timeoutSec ?? 10) * 1000, 1000), maxTimeout * 1000)
		ac.ctx.log.info(`ask: bash: ${command} (timeout=${timeoutMs}ms)`)
		try {
			const proc = Bun.spawn(['bash', '-c', command], {
				stdout: 'pipe',
				stderr: 'pipe',
			})
			const timeout = setTimeout(() => proc.kill(), timeoutMs)
			const exitCode = await proc.exited
			clearTimeout(timeout)
			const stdout = await new Response(proc.stdout).text()
			const stderr = await new Response(proc.stderr).text()
			const output = [stdout, stderr].filter(Boolean).join('\n')
			if (!output.trim()) return exitCode === 0 ? '(no output)' : `Exit code: ${exitCode}`
			const truncated = output.length > 4000 ? output.slice(0, 4000) + '\n[... truncated]' : output
			return exitCode === 0 ? truncated : `Exit code ${exitCode}:\n${truncated}`
		} catch (err) {
			return `Execution error: ${err instanceof Error ? err.message : String(err)}`
		}
	}

	return `Unknown tool: ${name}`
}

// ── Verify downloaded images with vision before sending ───────────────────

export async function verifyAndSendImages(
	ac: AskContext,
	question: string,
	sendImageFn: (path: string, caption: string) => Promise<void>,
): Promise<void> {
	for (const img of ac.downloadedImages) {
		try {
			const { readFileSync } = await import('node:fs')
			const imgBuffer = readFileSync(img.path)
			const imgBase64 = imgBuffer.toString('base64')
			const ext = img.path.split('.').pop() ?? 'jpg'
			const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'

			// Send image to LLM for verification
			const url = ac.config.apiUrl.endsWith('/')
				? `${ac.config.apiUrl}chat/completions`
				: `${ac.config.apiUrl}/chat/completions`
			const token = await getBearerToken(ac)
			const verifyResponse = await fetch(url, {
				method: 'POST',
				headers: getApiHeaders(ac, token),
				body: JSON.stringify({
					model: ac.config.model === 'auto' ? 'gpt-4o' : ac.config.model,
					messages: [
						{
							role: 'system',
							content:
								'You are an image verification assistant. You will receive an image and the original user question. Decide if the image is appropriate and relevant. Reply with ONLY a JSON object: {"send": true/false, "caption": "WhatsApp caption for the image"}. No other text.',
						},
						{
							role: 'user',
							content: [
								{ type: 'text', text: `Original question: ${question}\n\nIs this image relevant and appropriate?` },
								{ type: 'image_url', image_url: { url: `data:${mime};base64,${imgBase64}` } },
							],
						},
					],
					temperature: 0.3,
				}),
			})

			if (!verifyResponse.ok) {
				ac.ctx.log.warn(`ask: image verification API error: ${verifyResponse.status}`)
				continue
			}

			const vData = (await verifyResponse.json()) as any
			const vContent = (vData.choices?.[0]?.message?.content ?? '').trim()
			ac.ctx.log.info(`ask: image verification response: ${vContent}`)

			// Parse the JSON response
			try {
				const verdict = JSON.parse(vContent) as { send?: boolean; caption?: string }
				if (verdict.send && verdict.caption) {
					await sendImageFn(img.path, verdict.caption)
					ac.ctx.log.info(`ask: sent verified image with caption: ${verdict.caption}`)
				} else {
					ac.ctx.log.info(`ask: image verification rejected (send=${verdict.send})`)
				}
			} catch {
				// If JSON parse fails, try to send anyway with a default caption
				ac.ctx.log.warn(`ask: could not parse verification response, sending with default caption`)
				await sendImageFn(img.path, img.query)
			}
		} catch (err) {
			ac.ctx.log.warn(`ask: image verification/send failed: ${err instanceof Error ? err.message : String(err)}`)
		} finally {
			// Clean up temp file
			try {
				const { unlinkSync } = await import('node:fs')
				unlinkSync(img.path)
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}

// ── LLM call with function calling loop ───────────────────────────────────

export async function askAi(
	ac: AskContext,
	question: string,
	member: MemberInfo,
	media: IncomingMedia | null,
	senderLid: string,
	sourceContext: string,
	groupId?: string,
	isAdmin = false,
): Promise<string> {
	const { apiUrl, maxSearchRounds, systemPrompt, memoryKeepRecent } = ac.config

	// Build message array with memory context
	const memoryMessages: Array<{ role: string; content: string }> = []
	// Personal memory
	const rec = await loadMemory(ac, senderLid)
	if (rec?.summary) {
		memoryMessages.push({ role: 'system', content: `[Your previous conversation summary]\n${rec.summary}` })
	}
	if (rec?.messages.length) {
		const recent = rec.messages.slice(-memoryKeepRecent)
		for (const m of recent) {
			memoryMessages.push({ role: m.role, content: m.content })
		}
	}
	// Group memory (shared context from all members)
	if (groupId) {
		const groupRec = await loadGroupMemory(ac, groupId)
		if (groupRec?.summary) {
			memoryMessages.push({ role: 'system', content: `[Group conversation summary]\n${groupRec.summary}` })
		}
		if (groupRec?.messages.length) {
			const recentGroup = groupRec.messages.slice(-memoryKeepRecent)
			for (const m of recentGroup) {
				const label = (m as any).nickname ? `${(m as any).nickname}: ` : ''
				memoryMessages.push({ role: m.role, content: `${label}${m.content}` })
			}
		}
	}

	const url = apiUrl.endsWith('/') ? `${apiUrl}chat/completions` : `${apiUrl}/chat/completions`
	const token = await getBearerToken(ac)

	// Resolve model — auto routing or static
	let resolvedModel = ac.config.model
	let autoSessionToken: string | undefined
	if (ac.config.isCopilot && ac.config.model === 'auto') {
		try {
			const resolved = await copilotAutoModel.resolveModel(token, question)
			resolvedModel = resolved.model
			autoSessionToken = resolved.sessionToken
			ac.ctx.log.info(`ask: auto model resolved to ${resolvedModel}`)
		} catch (err) {
			ac.ctx.log.warn(
				`ask: auto model resolution failed, using gpt-4o: ${err instanceof Error ? err.message : String(err)}`,
			)
			resolvedModel = 'gpt-4o'
		}
	}

	// Build tool list
	const allTools = [
		...buildSearchTools(ac.config.webSearch),
		readFileTool,
		getMemberInfoTool,
		...(isAdmin ? buildAdminTools() : []),
	]

	// Build initial messages
	const messages: Array<Record<string, unknown>> = [
		{ role: 'system', content: systemPrompt + `\n\n[CONTEXT] Message source: ${sourceContext}` },
		...memoryMessages,
		{ role: 'user', content: buildUserContent(question, member, media) },
	]

	// Function calling loop
	for (let round = 0; round <= maxSearchRounds; round++) {
		const body: Record<string, unknown> = {
			model: resolvedModel,
			messages,
			temperature: 0.7,
		}
		if (allTools.length > 0) {
			body.tools = allTools
		}

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				...getApiHeaders(ac, token),
				...(autoSessionToken ? { 'Copilot-Session-Token': autoSessionToken } : {}),
			},
		})
		if (!response.ok) {
			const errBody = await response.text()
			throw new Error(`API ${response.status}: ${errBody}`)
		}
		const data = (await response.json()) as any
		const choice = data.choices?.[0]
		if (!choice) return '(no response)'

		// If no tool calls or finish_reason is 'stop', return the content
		const toolCalls = choice.message?.tool_calls as
			| Array<{ id: string; function: { name: string; arguments: string } }>
			| undefined
		if (!toolCalls || toolCalls.length === 0 || choice.finish_reason === 'stop') {
			return choice.message?.content?.trim() ?? '(no response)'
		}

		// Process tool calls: add assistant message with tool_calls, then tool results
		messages.push(choice.message)
		for (const tc of toolCalls) {
			try {
				const result = await executeToolCall(ac, tc.function.name, tc.function.arguments, groupId)
				messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err)
				ac.ctx.log.warn(`ask: tool call failed: ${errMsg}`)
				messages.push({ role: 'tool', tool_call_id: tc.id, content: `Search error: ${errMsg}` })
			}
		}
	}

	// Exhausted rounds — return last content if available
	const lastMsg = messages[messages.length - 1]
	return typeof lastMsg?.content === 'string' ? lastMsg.content : '(no response)'
}
