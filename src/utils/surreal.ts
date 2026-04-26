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
let tokenExpiresAt: number | null = null
let authCredentials: { username: string; password: string } | null = null

export interface SurrealOptions {
	endpoint?: string
	username?: string
	password?: string
	namespace?: string
	database?: string
}

/**
 * Decode JWT exp claim from an access token.
 * Returns expiry as ms timestamp, or null if not decodable.
 */
function decodeTokenExpiry(token: string): number | null {
	try {
		const parts = token.split('.')
		if (parts.length !== 3) return null
		const payloadPart = parts[1]
		if (!payloadPart) return null
		const payload = JSON.parse(atob(payloadPart))
		return payload.exp ? payload.exp * 1000 : null
	} catch {
		return null
	}
}

const TOKEN_REFRESH_THRESHOLD = 5 * 60 * 1000 // 5 minutes

/**
 * Subscribe to SurrealDB connection lifecycle events on an instance.
 * Logs connect/disconnect/reconnect/error state transitions.
 * Triggers automatic reconnection on disconnect.
 */
function subscribeLifecycle(instance: Surreal, label: string, onDisconnect: () => void): void {
	instance.subscribe('connected', (version) => {
		log.info(`${label} connected (${version})`)
	})
	instance.subscribe('disconnected', () => {
		log.warning(`${label} disconnected, scheduling reconnection...`)
		onDisconnect()
	})
	instance.subscribe('reconnecting', () => {
		log.warning(`${label} reconnecting...`)
	})
	instance.subscribe('error', (err) => {
		log.error(`${label} error: ${err instanceof Error ? err.message : String(err)}`)
	})
}

/**
 * Attempt to close a Surreal instance gracefully.
 * Best-effort — errors are logged, not thrown.
 */
async function closeInstance(instance: Surreal): Promise<void> {
	try {
		await instance.close()
	} catch (err) {
		log.debug('surreal:main failed to close old instance: {error}', {
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Schedule a reconnection attempt with exponential backoff.
 * Delegates actual retry logic to establishConnection() (infinite retry loop).
 * Closes the old instance and resets singleton state before reconnecting.
 */
function scheduleReconnect(label: string): void {
	if (reconnectScheduled) return
	reconnectScheduled = true

	const oldDb = db
	db = null
	connecting = null
	tokenExpiresAt = null

	// Close old instance in background (don't block reconnection)
	if (oldDb) void closeInstance(oldDb)

	log.debug(`${label} scheduling reconnection...`)

	// establishConnection() retries infinitely, so getDb() won't reject
	void getDb().then(
		() => {
			reconnectScheduled = false
			log.info(`${label} reconnection successful`)
		},
		() => {
			// Unreachable — establishConnection loops forever
		},
	)
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
		subscribeLifecycle(instance, 'surreal:main', () => scheduleReconnect('surreal:main'))

		try {
			log.debug('surreal:main connecting (attempt {attempt})', { attempt })
			await instance.connect(opts.endpoint!)
			const tokens = await instance.signin({
				username: opts.username!,
				password: opts.password!,
			})
			authCredentials = { username: opts.username!, password: opts.password! }
			tokenExpiresAt = decodeTokenExpiry(tokens.access)
			log.debug('surreal:main token expires at {expiresAt}', {
				expiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : 'unknown',
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

/**
 * Check if the auth token is expiring soon and re-signin if needed.
 * Called proactively before heartbeat writes to prevent session expiry.
 */
export async function refreshAuthIfNeeded(): Promise<void> {
	if (!tokenExpiresAt || !authCredentials || !db) return

	const remaining = tokenExpiresAt - Date.now()
	if (remaining > TOKEN_REFRESH_THRESHOLD) return

	log.info('surreal:main token expiring in {remaining}ms, refreshing auth...', { remaining })
	try {
		const tokens = await db.signin(authCredentials)
		tokenExpiresAt = decodeTokenExpiry(tokens.access)
		log.info('surreal:main token refreshed, expires at {expiresAt}', {
			expiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : 'unknown',
		})
	} catch (err) {
		log.error('surreal:main token refresh failed: {error}', {
			error: err instanceof Error ? err.message : String(err),
		})
	}
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
	reconnectScheduled = false
	tokenExpiresAt = null
	authCredentials = null
}
