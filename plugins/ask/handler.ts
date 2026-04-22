import type { IncomingMedia } from '../../src/types.ts'
import { askAi, verifyAndSendImages } from './llm.ts'
import { compactMemoryIfNeeded, resolveMember, saveGroupMemoryEntry, saveMemoryEntry } from './memory.ts'
import { stripOwnMention } from './mention.ts'
import type { AskContext } from './types.ts'
import { formatWibHourMinute, normalizeForWhatsApp } from './utils.ts'
import { DEFAULT_RATE_LIMIT_RESET_CRON, nextCronRunWib, parseMinuteHourCron } from './utils.ts'

// --- Core handler shared by group + DM ---
export async function handleAsk(
	ac: AskContext,
	text: string,
	media: IncomingMedia | null,
	senderLid: string | null,
	reply: (msg: string) => Promise<void>,
	reactFn: ((emoji: string) => Promise<void>) | null,
	sourceContext: string,
	sendImageFn?: (path: string, caption: string) => Promise<void>,
	groupId?: string,
): Promise<void> {
	// Check if plugin is closed
	if (ac.closedMessage.current) {
		await reply(ac.closedMessage.current)
		return
	}
	const question = text.replace(/^\/ask\s*/, '').trim()
	if (!question && !media) {
		await reply('❓ Ketik /ask <pertanyaan> (DM) atau mention @Bearcu di grup.')
		return
	}

	if (!senderLid) {
		ac.ctx.log.warn('ask: no sender LID, skipping')
		return
	}

	const member = await resolveMember(ac, senderLid)
	if (!member) {
		await reply('❌ Kamu bukan member MEDRIVIA.')
		return
	}

	const isAdmin = senderLid != null && ac.config.adminLids.has(senderLid)
	if (!isAdmin) {
		const count = ac.rateLimits.get(senderLid) ?? 0
		if (count >= ac.config.maxMessages) {
			const nextResetWib = formatWibHourMinute(getNextResetAt(ac))
			await reply(
				`🐻 Hai, ${member.nickname}. Tunggu pukul ${nextResetWib} WIB biar Bearcu bisa jawab, ya!`,
			)
			return
		}
		ac.rateLimits.set(senderLid, count + 1)
	}

	const actualQuestion = media ? (question || '(describe this image)') : question
	const cleanQuestion = stripOwnMention(ac, actualQuestion) || actualQuestion
	const effectiveQuestion = cleanQuestion || '(no text)'
	const now = Date.now()

	// Save user message to personal memory
	await saveMemoryEntry(ac, senderLid, { role: 'user', content: effectiveQuestion, ts: now })
	// Save to group memory if in a group
	if (groupId) {
		await saveGroupMemoryEntry(ac, groupId, {
			role: 'user',
			content: effectiveQuestion,
			ts: now,
			nickname: member.nickname,
		})
	}
	// Auto-compact if memory is getting long
	await compactMemoryIfNeeded(ac, senderLid)

	// React 💭 before processing
	try {
		if (reactFn) await reactFn(ac.config.thinkEmoji)
	} catch {
		// Non-fatal: reaction failure must not block
	}

	ac.ctx.log.info(
		`ask: processing for ${member.nickname} (${sourceContext}) question=${JSON.stringify(effectiveQuestion)}${
			media ? ' [with image]' : ''
		})`,
	)

	try {
		const rawAnswer = await askAi(ac, effectiveQuestion, member, media, senderLid, sourceContext, groupId, isAdmin)
		const answer = normalizeForWhatsApp(rawAnswer)
		await reply(answer)

		// Send verified images if any were downloaded during tool calls
		if (ac.downloadedImages.length > 0 && sendImageFn) {
			await verifyAndSendImages(ac, effectiveQuestion, sendImageFn)
		}

		// Save assistant reply to personal memory
		await saveMemoryEntry(ac, senderLid, { role: 'assistant', content: answer, ts: Date.now() })
		// Save assistant reply to group memory
		if (groupId) {
			await saveGroupMemoryEntry(ac, groupId, { role: 'assistant', content: answer, ts: Date.now() })
		}
		// React ✅ after successful response
		try {
			if (reactFn) await reactFn(ac.config.doneEmoji)
		} catch {
			// Non-fatal
		}

		ac.ctx.log.info(
			`ask: answered for LID=${senderLid} (${effectiveQuestion.length} chars, ${
				media ? 'with image' : 'text-only'
			} → ${answer.length} chars)`,
		)
	} catch (error) {
		ac.ctx.log.error(`ask: API error: ${error instanceof Error ? error.message : String(error)}`)
		await reply('⚠️ AI error. Coba lagi nanti.')
	}
}

function getNextResetAt(ac: AskContext): Date {
	const parsed = ac._parsedResetCron ?? parseMinuteHourCron(DEFAULT_RATE_LIMIT_RESET_CRON)
	if (!parsed) return new Date(Date.now() + 30 * 60 * 1000)
	return nextCronRunWib(parsed)
}
