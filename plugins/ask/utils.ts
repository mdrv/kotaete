import type { IncomingMedia } from '../../src/types.ts'
import type { MemberInfo } from './types.ts'
import { DEFAULT_RATE_LIMIT_RESET_CRON, type ParsedMinuteHourCron, WIB_OFFSET_MS } from './types.ts'

// ── WhatsApp markdown normalizer ──────────────────────────────────────────

export function normalizeForWhatsApp(text: string): string {
	// Strip markdown tables (lines starting with |)
	let out = text.replace(/(^|\n)\|.*\|\s*\n/g, '$1')
	// Strip markdown image syntax: ![alt](url) → remove entirely (images sent separately)
	out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
	// Strip markdown link syntax but keep visible text: [caption](url) → caption
	out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
	// Convert ##/### style headings to bold
	out = out.replace(/^#{1,3}\s+(.+)/gm, '*$1*')
	// Convert bullet list markers -/• to •
	out = out.replace(/^\s*[-*]\s+/gm, '• ')
	// Collapse 3+ newlines to 2
	out = out.replace(/\n{3,}/g, '\n\n')
	// Trim trailing whitespace per line
	out = out.replace(/[ \t]+$/gm, '')
	return out.trim()
}

/** Build OpenAI-compatible user content — multimodal if media present */
export function buildUserContent(
	question: string,
	member: MemberInfo,
	media: IncomingMedia | null,
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
	const prefix = `[${member.nickname} (${member.primaryMid})]`

	if (media?.base64) {
		return [
			{ type: 'text', text: `${prefix} ${question}` },
			{ type: 'image_url', image_url: { url: `data:${media.mimeType};base64,${media.base64}` } },
		]
	}

	return `${prefix} ${question}`
}

// ── Cron helpers ──────────────────────────────────────────────────────────

export function parseCronPart(part: string, min: number, max: number): Set<number> | null {
	if (part === '*') {
		const all = new Set<number>()
		for (let i = min; i <= max; i++) all.add(i)
		return all
	}

	if (part.startsWith('*/')) {
		const step = Number(part.slice(2))
		if (!Number.isInteger(step) || step <= 0) return null
		const values = new Set<number>()
		for (let i = min; i <= max; i += step) values.add(i)
		return values
	}

	const values = new Set<number>()
	for (const raw of part.split(',')) {
		const n = Number(raw.trim())
		if (!Number.isInteger(n) || n < min || n > max) return null
		values.add(n)
	}
	return values.size > 0 ? values : null
}

export function parseMinuteHourCron(expr: string): ParsedMinuteHourCron | null {
	const parts = expr.trim().split(/\s+/)
	if (parts.length !== 5) return null
	const [minPart, hourPart] = parts
	const minutes = parseCronPart(minPart, 0, 59)
	const hours = parseCronPart(hourPart, 0, 23)
	if (!minutes || !hours) return null
	return { minutes, hours }
}

export function formatWibHourMinute(date: Date): string {
	const wib = new Date(date.getTime() + WIB_OFFSET_MS)
	const hh = String(wib.getUTCHours()).padStart(2, '0')
	const mm = String(wib.getUTCMinutes()).padStart(2, '0')
	return `${hh}.${mm}`
}

export function nextCronRunWib(parsed: ParsedMinuteHourCron, fromMs = Date.now()): Date {
	const aligned = fromMs - (fromMs % 60_000) + 60_000
	const maxSteps = 60 * 24 * 14
	for (let i = 0; i < maxSteps; i++) {
		const ts = aligned + i * 60_000
		const wib = new Date(ts + WIB_OFFSET_MS)
		if (parsed.hours.has(wib.getUTCHours()) && parsed.minutes.has(wib.getUTCMinutes())) {
			return new Date(ts)
		}
	}
	return new Date(aligned + 30 * 60_000)
}

/** Re-export for convenience */
export { DEFAULT_RATE_LIMIT_RESET_CRON }
