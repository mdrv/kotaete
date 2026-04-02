const DIGITS_RE = /\D/g

/**
 * Strip everything that is not a digit from the input string.
 * Returns the empty string if `raw` contains no digits.
 */
export function normalizePhoneNumber(raw: string): string {
	return raw.replace(DIGITS_RE, '')
}

/**
 * Extract a plain phone number from a WhatsApp JID or raw phone string.
 *
 * Handles:
 * - `12345@s.whatsapp.net`
 * - `12345:6@s.whatsapp.net`  (Android legacy multi-device)
 * - `12345@lid`               (linked device)
 * - `+62 812-3456 7890`       (arbitrary punctuation / spaces)
 *
 * Returns `null` when the resulting digits string is empty.
 */
export function normalizeJidNumber(jidOrPhone: string): string | null {
	const raw = jidOrPhone.trim().replace(/^whatsapp:/, '')
	if (!raw) return null

	if (raw.includes('@')) {
		const [userPart] = raw.split('@')
		const normalizedUser = (userPart ?? '').split(':')[0] ?? ''
		const digits = normalizedUser.replace(DIGITS_RE, '')
		return digits.length > 0 ? digits : null
	}

	const digits = raw.replace(DIGITS_RE, '')
	return digits.length > 0 ? digits : null
}
