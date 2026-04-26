import { RecordId, Surreal } from 'surrealdb'
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
let tokenExpiresAt: number | null = null
let authCredentials: { username: string; password: string } | null = null

const HEARTBEAT_INTERVAL = 15_000
const TOKEN_REFRESH_THRESHOLD = 5 * 60 * 1000 // 5 minutes
const instanceName = process.env.INSTANCE_NAME ?? 'default'
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let heartbeatStarted = false
let heartbeatFailCount = 0
const HEARTBEAT_FAIL_THRESHOLD = 3

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

/**
 * Check if the auth token is expiring soon and re-signin if needed.
 * Called proactively before heartbeat writes to prevent session expiry.
 */
async function refreshAuthIfNeeded(instance: Surreal): Promise<void> {
	if (!tokenExpiresAt || !authCredentials) return

	const remaining = tokenExpiresAt - Date.now()
	if (remaining > TOKEN_REFRESH_THRESHOLD) return

	log.info('surreal:web token expiring in {remaining}ms, refreshing auth...', { remaining })
	try {
		const tokens = await instance.signin(authCredentials)
		tokenExpiresAt = decodeTokenExpiry(tokens.access)
		log.info('surreal:web token refreshed, expires at {expiresAt}', {
			expiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : 'unknown',
		})
	} catch (err) {
		log.error('surreal:web token refresh failed: {error}', {
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
/**
 * Subscribe to SurrealDB connection lifecycle events.
 * Logs connect/disconnect/reconnect/error state transitions.
 * Triggers automatic reconnection on disconnect.
 */
function subscribeLifecycle(instance: Surreal, label: string, onDisconnect: () => void): void {
	instance.subscribe('connected', (version) => {
		log.info(`${label} connected (v${version})`)
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
		log.debug('surreal:web failed to close old instance: {error}', {
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
async function establishConnection(): Promise<Surreal> {
	let attempt = 0
	const maxDelay = 30_000 // 30 seconds cap

	while (true) {
		attempt++
		const instance = new Surreal()
		subscribeLifecycle(instance, 'surreal:web', () => scheduleReconnect('surreal:web'))

		try {
			log.debug('surreal:web connecting (attempt {attempt})', { attempt })
			await instance.connect(SURREAL_ENDPOINT)
			const tokens = await instance.signin({
				username: SURREAL_USERNAME,
				password: SURREAL_PASSWORD,
			})
			authCredentials = { username: SURREAL_USERNAME, password: SURREAL_PASSWORD }
			tokenExpiresAt = decodeTokenExpiry(tokens.access)
			log.debug('surreal:web token expires at {expiresAt}', {
				expiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : 'unknown',
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

			// Ensure web_status table exists (only created by daemon init otherwise)
			try {
				await instance.query(`DEFINE TABLE OVERWRITE web_status SCHEMAFULL`)
				await instance.query(`DEFINE FIELD OVERWRITE status ON web_status TYPE string DEFAULT 'starting'`)
				await instance.query(`DEFINE FIELD OVERWRITE last_heartbeat_at ON web_status TYPE option<datetime>`)
				await instance.query(`DEFINE FIELD OVERWRITE started_at ON web_status TYPE datetime DEFAULT time::now()`)
				await instance.query(`DEFINE FIELD OVERWRITE pid ON web_status TYPE number`)
			} catch (err) {
				log.warning('surreal:web failed to define web_status schema: {error}', {
					error: err instanceof Error ? err.message : String(err),
				})
			}

			// Start heartbeat (only once across reconnects)
			if (!heartbeatStarted) {
				heartbeatStarted = true
				void updateWebStatus(instance, 'running')
				heartbeatTimer = setInterval(() => {
					const current = db
					if (current) {
						void refreshAuthIfNeeded(current).then(() => updateWebStatus(current, 'running'))
					}
				}, HEARTBEAT_INTERVAL)
				log.info('surreal:web heartbeat started (instance={instanceName}, interval={interval}ms)', {
					instanceName,
					interval: HEARTBEAT_INTERVAL,
				})
			}

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

/**
 * Update web_status heartbeat record for this instance.
 */
async function updateWebStatus(instance: Surreal, status: string): Promise<void> {
	log.trace('heartbeat: updating web_status:{instanceName} status={status}', { instanceName, status })
	try {
		const [result] = await instance.query(
			`UPSERT $id SET status = $status, last_heartbeat_at = time::now(), pid = $pid, started_at = started_at ?? time::now()`,
			{ id: new RecordId('web_status', instanceName), status, pid: process.pid },
		)
		log.trace('heartbeat: web_status:{instanceName} updated', { instanceName, result: JSON.stringify(result) })
		heartbeatFailCount = 0
	} catch (err) {
		heartbeatFailCount++
		log.error('heartbeat: web_status:{instanceName} failed ({failCount}/{threshold}): {error}', {
			instanceName,
			failCount: heartbeatFailCount,
			threshold: HEARTBEAT_FAIL_THRESHOLD,
			error: err instanceof Error ? err.message : String(err),
		})
		if (heartbeatFailCount >= HEARTBEAT_FAIL_THRESHOLD) {
			log.warning('heartbeat: {failCount} consecutive failures, triggering reconnection', {
				failCount: heartbeatFailCount,
			})
			heartbeatFailCount = 0
			scheduleReconnect('surreal:web')
		}
	}
}

/** Stop the heartbeat and mark the instance as stopped. */
export async function stopHeartbeat(): Promise<void> {
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer)
		heartbeatTimer = null
	}
	const current = db
	if (!current) return

	log.info('heartbeat: marking web_status:{instanceName} stopped', { instanceName })
	try {
		await current.query(
			`UPSERT $id SET status = 'stopped', last_heartbeat_at = time::now()`,
			{ id: new RecordId('web_status', instanceName) },
		)
	} catch (err) {
		log.error('heartbeat: web_status:{instanceName} stop failed: {error}', {
			instanceName,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
