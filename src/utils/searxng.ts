/**
 * SearXNG search utility for Kotaete ask plugin.
 * Uses direct fetch() — no npm dependencies needed.
 */

export interface SearXNGResult {
	url: string
	title: string
	content: string
	engine: string
	engines: string[]
	score: number
	category: string
	thumbnail?: string | null
	img_src?: string
}

export interface SearXNGResponse {
	query: string
	number_of_results: number
	results: SearXNGResult[]
	suggestions?: string[]
	unresponsive_engines?: Array<[string, string]>
}

export interface SearchOptions {
	categories?: string
	engines?: string
	language?: string
	pageno?: number
	time_range?: 'day' | 'month' | 'year'
	maxResults?: number
	timeout?: number
}

export interface SearXNGConfig {
	baseUrl: string
	authUsername: string
	authPassword: string
}

/** Get SearXNG config from provided values with env fallbacks. */
export function getSearXNGConfig(overrides?: Partial<SearXNGConfig>): SearXNGConfig {
	return {
		baseUrl: overrides?.baseUrl
			?? process.env.SEARXNG_URL
			?? 'https://s.bearcu.id',
		authUsername: overrides?.authUsername
			?? process.env.SEARXNG_AUTH_USERNAME
			?? 'ua',
		authPassword: overrides?.authPassword
			?? process.env.SEARXNG_AUTH_PASSWORD
			?? 'japan8',
	}
}

/** Search SearXNG and return structured results. */
export async function searxngSearch(
	query: string,
	config: SearXNGConfig,
	options: SearchOptions = {},
): Promise<SearXNGResponse> {
	const {
		categories,
		engines,
		language = 'auto',
		pageno = 1,
		time_range,
		maxResults = 5,
		timeout = 15_000,
	} = options

	const params = new URLSearchParams({
		q: query,
		format: 'json',
		language,
		pageno: String(pageno),
		safesearch: '1',
	})

	if (categories) params.set('categories', categories)
	if (engines) params.set('engines', engines)
	if (time_range) params.set('time_range', time_range)

	const url = `${config.baseUrl}/search?${params}`
	const auth = btoa(`${config.authUsername}:${config.authPassword}`)

	const response = await fetch(url, {
		headers: {
			Authorization: `Basic ${auth}`,
			Accept: 'application/json',
		},
		signal: AbortSignal.timeout(timeout),
	})

	if (!response.ok) {
		throw new Error(`SearXNG ${response.status}: ${response.statusText}`)
	}

	const data = (await response.json()) as SearXNGResponse

	// Client-side truncation
	if (data.results.length > maxResults) {
		data.results = data.results.slice(0, maxResults)
	}

	return data
}

/** Format search results as a text block for LLM consumption. */
export function formatSearchResults(data: SearXNGResponse): string {
	if (data.results.length === 0) {
		return `No results found for "${data.query}"`
	}

	const lines = data.results.map(
		(r, i) => `${i + 1}. ${r.title}\n   ${r.content}\n   ${r.url}`,
	)
	return `[Web Search Results for "${data.query}"]\n\n${lines.join('\n\n')}`
}
