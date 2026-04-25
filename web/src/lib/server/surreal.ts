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

/**
 * Subscribe to SurrealDB connection lifecycle events.
 * Logs connect/disconnect/reconnect/error state transitions.
 */
function subscribeLifecycle(instance: Surreal, label: string): void {
	instance.subscribe('connected', (version) => {
		log.info(`${label} connected (v${version})`)
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

export async function getDb(): Promise<Surreal> {
	if (db) return db
	if (connecting) return connecting

	connecting = (async () => {
		const instance = new Surreal()
		subscribeLifecycle(instance, 'surreal:web')
		await instance.connect(SURREAL_ENDPOINT)
		await instance.signin({
			username: SURREAL_USERNAME,
			password: SURREAL_PASSWORD,
		})
		await instance.use({
			namespace: SURREAL_NAMESPACE,
			database: SURREAL_DATABASE,
		})
		log.info('connection established', {
			endpoint: SURREAL_ENDPOINT,
			namespace: SURREAL_NAMESPACE,
			database: SURREAL_DATABASE,
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

/** Check if the connection is currently connected. */
export function isConnected(): boolean {
	return db?.status === 'connected'
}
