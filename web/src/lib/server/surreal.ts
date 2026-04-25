import { type ConnectionStatus, Surreal } from 'surrealdb'
import { getLogger } from './logger'

const log = getLogger(['kotaete', 'web', 'surreal'])

const {
	SURREAL_ENDPOINT = 'ws://localhost:596',
	SURREAL_USERNAME = 'ua',
	SURREAL_PASSWORD = 'japan8',
	SURREAL_NAMESPACE = 'medrivia',
	SURREAL_DATABASE = 'nipbang_kotaete',
} = process.env

let db: Surreal | null = null
let connecting: Promise<Surreal> | null = null
let reconnectScheduled = false

/**
 * Subscribe to SurrealDB connection lifecycle events.
 * Logs connect/disconnect/reconnect/error state transitions.
 * Triggers automatic reconnection on disconnect.
 */
function subscribeLifecycle(instance: Surreal, label: string): void {
	instance.subscribe('connected', (version) => {
		log.info(`${label} connected (v${version})`)
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

	async function attemptReconnect(): Promise<void> {
		const delay = Math.min(Math.pow(2, attempt) * 1000, maxDelay)
		attempt++

		log.debug(`${label} reconnecting in {delay}ms (attempt {attempt})`, { delay, attempt })
		await new Promise((resolve) => setTimeout(resolve, delay))

		// Reset connection state and try again
		db = null
		connecting = null

		try {
			await getDb()
			reconnectScheduled = false
		} catch (err) {
			log.error(`${label} reconnection attempt {attempt} failed, retrying...`, {
				attempt,
				error: err instanceof Error ? err.message : String(err),
			})
			await attemptReconnect()
		}
	}

	void attemptReconnect()
}

/**
 * Establish a connection with retry logic.
 * Retries infinitely with exponential backoff on failure.
 */
async function establishConnection(): Promise<Surreal> {
	let attempt = 0
	const maxDelay = 30_000 // 30 seconds cap

	while (true) {
		attempt++
		const instance = new Surreal()
		subscribeLifecycle(instance, 'surreal:web')

		try {
			log.debug('surreal:web connecting (attempt {attempt})', { attempt })
			await instance.connect(SURREAL_ENDPOINT)
			await instance.signin({
				username: SURREAL_USERNAME,
				password: SURREAL_PASSWORD,
			})
			await instance.use({
				namespace: SURREAL_NAMESPACE,
				database: SURREAL_DATABASE,
			})
			log.info('surreal:web connection established', {
				endpoint: SURREAL_ENDPOINT,
				namespace: SURREAL_NAMESPACE,
				database: SURREAL_DATABASE,
			})
			return instance
		} catch (err) {
			log.error('surreal:web connection attempt {attempt} failed, retrying...', {
				attempt,
				error: err instanceof Error ? err.message : String(err),
			})

			const delay = Math.min(Math.pow(2, attempt) * 1000, maxDelay)
			log.debug('surreal:web waiting {delay}ms before retry', { delay })
			await new Promise((resolve) => setTimeout(resolve, delay))
		}
	}
}

export async function getDb(): Promise<Surreal> {
	if (db) return db
	if (connecting) return connecting

	connecting = (async () => {
		const instance = await establishConnection()
		db = instance
		return instance
	})()

	return connecting
}

/** Get the current connection status, or null if never connected. */
export function getConnectionStatus(): ConnectionStatus | null {
	return db?.status ?? null
}

/** Check if the connection is currently connected. */
export function isConnected(): boolean {
	return db?.status === 'connected'
}
