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
let reconnectScheduled = false

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
 * Triggers automatic reconnection on disconnect.
 */
function subscribeLifecycle(instance: Surreal, label: string): void {
	instance.subscribe('connected', (version) => {
		log.info(`${label} connected (${version})`)
	})
	instance.subscribe('disconnected', () => {
		log.warning(`${label} disconnected, scheduling reconnection...`)
		scheduleReconnect(label)
	})
	instance.subscribe('reconnecting', () => {
		log.warning(`${label} reconnecting...`)
	})
	instance.subscribe('error', (err) => {
		log.error(`${label} error: ${err instanceof Error ? err.message : String(err)}`)
	})
}

/**
 * Schedule a reconnection attempt with exponential backoff.
 * Retries infinitely with increasing delay (1s → 2s → 4s → 8s → 16s, capped at 30s).
 */
function scheduleReconnect(label: string): void {
	if (reconnectScheduled) return
	reconnectScheduled = true

	let attempt = 0
	const maxDelay = 30_000 // 30 seconds cap

	async function attemptReconnect(options?: SurrealOptions): Promise<void> {
		const delay = Math.min(Math.pow(2, attempt) * 1000, maxDelay)
		attempt++

		log.debug(`${label} reconnecting in {delay}ms (attempt {attempt})`, { delay, attempt })
		await new Promise((resolve) => setTimeout(resolve, delay))

		// Reset connection state and try again
		db = null
		connecting = null

		try {
			await getDb(options)
			reconnectScheduled = false
		} catch (err) {
			log.error(`${label} reconnection attempt {attempt} failed, retrying...`, {
				attempt,
				error: err instanceof Error ? err.message : String(err),
			})
			await attemptReconnect(options)
		}
	}

	void attemptReconnect()
}

/**
 * Establish a connection with retry logic.
 * Retries infinitely with exponential backoff on failure.
 */
async function establishConnection(opts: SurrealOptions): Promise<Surreal> {
	let attempt = 0
	const maxDelay = 30_000 // 30 seconds cap

	while (true) {
		attempt++
		const instance = new Surreal()
		subscribeLifecycle(instance, 'surreal:main')

		try {
			log.debug('surreal:main connecting (attempt {attempt})', { attempt })
			await instance.connect(opts.endpoint!)
			await instance.signin({
				username: opts.username!,
				password: opts.password!,
			})
			await instance.use({
				namespace: opts.namespace!,
				database: opts.database!,
			})
			log.info('surreal:main connection established', {
				endpoint: opts.endpoint,
				namespace: opts.namespace,
				database: opts.database,
			})
			return instance
		} catch (err) {
			log.error('surreal:main connection attempt {attempt} failed, retrying...', {
				attempt,
				error: err instanceof Error ? err.message : String(err),
			})

			const delay = Math.min(Math.pow(2, attempt) * 1000, maxDelay)
			log.debug('surreal:main waiting {delay}ms before retry', { delay })
			await new Promise((resolve) => setTimeout(resolve, delay))
		}
	}
}

/**
 * Get or create the shared SurrealDB connection singleton.
 * Uses a deduplication promise to prevent multiple concurrent connections.
 * Retries infinitely with exponential backoff on failure.
 * Subscribes to connection lifecycle events for debug logging.
 */
export async function getDb(options?: SurrealOptions): Promise<Surreal> {
	if (db) return db
	if (connecting) return connecting

	const opts = { ...SURREAL_DEFAULTS, ...options }

	connecting = (async () => {
		const instance = await establishConnection(opts)
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
