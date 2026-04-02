const MULTI_SPACE_RE = /\s+/g
const SLASH_RE = /\//

/**
 * Normalize an answer string for comparison:
 * - trim whitespace
 * - collapse internal whitespace runs to a single space
 * - lowercase
 */
export function normalizeAnswer(input: string): string {
	return input.trim().replace(MULTI_SPACE_RE, ' ').toLowerCase()
}

/**
 * Build a Set of normalized acceptable answers from the raw answers array.
 * Each raw answer is normalized, then split on `/` so that slash-delimited
 * variant strings (e.g. `"red/blue"`) are accepted independently.
 */
export function buildAnswerSet(
	answers: ReadonlyArray<string>,
): Set<string> {
	const set = new Set<string>()
	for (const raw of answers) {
		const normalized = normalizeAnswer(raw)
		if (normalized.length === 0) continue
		for (const variant of normalized.split(SLASH_RE)) {
			const trimmed = variant.trim()
			if (trimmed.length > 0) set.add(trimmed)
		}
	}
	return set
}

/**
 * Check whether the given `input` matches any of the accepted `answers`.
 */
export function isCorrectAnswer(
	input: string,
	answers: ReadonlyArray<string>,
): boolean {
	return buildAnswerSet(answers).has(normalizeAnswer(input))
}
