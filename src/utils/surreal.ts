import { type ConnectionStatus, Surreal } from 'surrealdb'
import { getLogger } from '../logger.ts'

const log = getLogger(['kotaete', 'surreal'])

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
 * Subscribe to SurrealDB connection lifecycle events on an instance.
 * Logs connect/disconnect/reconnect/error state transitions.
 */
function subscribeLifecycle(instance: Surreal, label: string): void {
	instance.subscribe('connected', (version) => {
		log.info(`${label} connected (${version})`)
	})
	instance.subscribe('disconnected', () => {
		log.warning(`${label} disconnected`)
	})
	instance.subscribe('reconnecting', () => {
		log.warning(`${label} reconnecting...`)
	})
	instance.subscribe('error', (err) => {
		log.error(`${label} error: ${err instanceof Error ? err.message : String(err)}`)
	})
}

/**
 * Get or create the shared SurrealDB connection singleton.
 * Uses a deduplication promise to prevent multiple concurrent connections.
 * Subscribes to connection lifecycle events for debug logging.
 */
export async function getDb(options?: SurrealOptions): Promise<Surreal> {
	if (db) return db
	if (connecting) return connecting

	const opts = { ...SURREAL_DEFAULTS, ...options }

	connecting = (async () => {
		const instance = new Surreal()
		subscribeLifecycle(instance, 'surreal:main')
		await instance.connect(opts.endpoint)
		await instance.signin({
			username: opts.username,
			password: opts.password,
		})
		await instance.use({
			namespace: opts.namespace,
			database: opts.database,
		})
		log.info('surreal:main connection established', {
			endpoint: opts.endpoint,
			namespace: opts.namespace,
			database: opts.database,
		})
		db = instance
		return instance
	})()

	return connecting
}

/** Get the current connection status, or null if never connected. */
export function getConnectionStatus(): ConnectionStatus | null {
	return db?.status ?? null
}

/** Check if the shared connection is currently connected. */
export function isConnected(): boolean {
	return db?.status === 'connected'
}

/**
 * Run a SurrealDB health check (round-trip to server).
 * Throws if the connection is dead or server is unreachable.
 */
export async function healthCheck(): Promise<void> {
	if (!db) throw new Error('SurrealDB not initialized')
	await db.health()
}

/**
 * Reset the singleton (for testing or clean shutdown).
 */
export function resetDb(): void {
	db = null
	connecting = null
}
