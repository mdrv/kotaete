import { Surreal } from 'surrealdb'

export const SURREAL_DEFAULTS = {
	endpoint: 'http://localhost:596/rpc',
	username: 'ua',
	password: 'japan8',
	namespace: 'medrivia',
	database: 'nipbang_kotaete',
} as const

let db: Surreal | null = null
let connecting: Promise<Surreal> | null = null

export interface SurrealOptions {
	endpoint?: string
	username?: string
	password?: string
	namespace?: string
	database?: string
}

/**
 * Get or create the shared SurrealDB connection singleton.
 * Uses a deduplication promise to prevent multiple concurrent connections.
 */
export async function getDb(options?: SurrealOptions): Promise<Surreal> {
	if (db) return db
	if (connecting) return connecting

	const opts = { ...SURREAL_DEFAULTS, ...options }

	connecting = (async () => {
		const instance = new Surreal()
		await instance.connect(opts.endpoint)
		await instance.signin({
			username: opts.username,
			password: opts.password,
		})
		await instance.use({
			namespace: opts.namespace,
			database: opts.database,
		})
		db = instance
		return instance
	})()

	return connecting
}

/**
 * Reset the singleton (for testing or clean shutdown).
 */
export function resetDb(): void {
	db = null
	connecting = null
}
