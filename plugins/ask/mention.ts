import { resolveMember } from './memory.ts'
import type { AskContext } from './types.ts'

// Check if bot is among mentioned JIDs
export async function isBotMentioned(ac: AskContext, mentionedJids: string[], text: string): Promise<boolean> {
	const ownJid = ac.ctx.getOwnJid()
	if (!ownJid) {
		// Fallback: check text for bot name
		return /@Bearcu/i.test(text)
	}
	const ownBare = ownJid.split('@')[0]?.split(':')[0] ?? ''
	for (const jid of mentionedJids) {
		const bare = jid.split('@')[0]?.split(':')[0] ?? ''
		if (bare === ownBare) return true
		// LID mentions need PN resolution to compare with bot's phone-based JID
		if (jid.endsWith('@lid')) {
			const pn = await ac.ctx.lookupPnByLid(jid)
			if (pn) {
				const pnBare = pn.split('@')[0]?.split(':')[0] ?? ''
				if (pnBare === ownBare) return true
			}
		}
	}
	return false
}

// Resolve @<bare_number> mentions to member nicknames
export async function resolveMentions(ac: AskContext, text: string, mentionedJids: string[]): Promise<string> {
	if (mentionedJids.length === 0) return text
	let resolved = text
	for (const jid of mentionedJids) {
		const bare = jid.split('@')[0]?.split(':')[0] ?? ''
		if (!bare) continue

		// Try to resolve to a member name via LID lookup
		let member = await resolveMember(ac, jid)
		// Fallback: if jid is a PN (s.whatsapp.net), try PN→LID lookup then resolveMember
		if (!member && jid.includes('@s.whatsapp.net')) {
			const lid = await ac.ctx.lookupLidByPn(bare)
			if (lid) member = await resolveMember(ac, lid)
		}
		// Fallback: if jid is LID-based, try LID→PN to get member by phone
		if (!member && jid.includes('@lid')) {
			const pn = await ac.ctx.lookupPnByLid(jid)
			if (pn) member = await resolveMember(ac, `${pn}@s.whatsapp.net`)
		}
		const displayName = member?.nickname ?? bare

		// Replace @<bare> with @<displayName>
		resolved = resolved.replace(new RegExp(`@${escapeRegExp(bare)}`, 'g'), `@${displayName}`)
	}
	return resolved
}

// Strip the bot's own mention from text
export function stripOwnMention(ac: AskContext, text: string): string {
	const ownJid = ac.ctx.getOwnJid()
	if (!ownJid) return text.replace(/@Bearcu\s*/gi, '')
	const ownBare = ownJid.split('@')[0]?.split(':')[0] ?? ''
	if (!ownBare) return text
	return text.replace(new RegExp(`@${escapeRegExp(ownBare)}\\s*`, 'g'), '').replace(/@Bearcu\s*/gi, '').trim()
}

export function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
