import type { IncomingMessage } from 'node:http'
import { type LiveSubscription, RecordId, Table } from 'surrealdb'
import { type WebSocket, WebSocketServer } from 'ws'
import { getLogger } from './logger'
import { getDb } from './surreal'

const TABLES = ['quiz_event', 'live_score', 'live_member_state', 'quiz_session', 'season_score'] as const
const WS_PATH = '/api/ws'
const log = getLogger(['kotaete', 'web', 'ws'])

/** Recursively convert RecordId objects to 'table:id' strings for JSON serialization */
function normalizeRecordIds(value: unknown): unknown {
	if (value instanceof RecordId) return String(value)
	if (Array.isArray(value)) return value.map(normalizeRecordIds)
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = normalizeRecordIds(v)
		}
		return out
	}
	return value
}

export interface WsOutMessage {
	type: 'live' | 'viewers' | 'error'
	table?: string
	action?: string
	record?: unknown
	count?: number
}

export interface WsInMessage {
	type: string
	[key: string]: unknown
}

export class KotaeteWsServer {
	private wss: WebSocketServer
	private subs: LiveSubscription[] = []
	private subReady = false

	constructor() {
		this.wss = new WebSocketServer({ noServer: true })
		this.wss.on('connection', this.handleConnection.bind(this))
		log.info('WebSocket server created')
	}

	/** Attach to an HTTP server's upgrade event */
	attachUpgrade(httpServer: { on: (event: string, listener: (...args: any[]) => void) => any }) {
		httpServer.on('upgrade', (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
			const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host}`)
			if (pathname === WS_PATH) {
				this.wss.handleUpgrade(req, socket, head, (ws) => {
					this.wss.emit('connection', ws, req)
				})
			}
			// Don't touch other paths — Vite HMR needs them
		})
	}

	private handleConnection(ws: WebSocket, req: IncomingMessage) {
		const ip = req.socket.remoteAddress
		log.info('client connected', { ip, clients: this.wss.clients.size })

		// Start shared SurrealDB subscriptions on first client
		this.ensureSubscriptions()

		// Send viewer count to the new client, broadcast to all
		this.broadcastViewers()

		// Heartbeat per client
		let alive = true
		const ping = setInterval(() => {
			if (!alive) return
			if (ws.readyState === ws.OPEN) {
				ws.ping()
			}
		}, 30_000)

		ws.on('pong', () => {
			alive = true
		})

		ws.on('message', (raw) => {
			try {
				const msg: WsInMessage = JSON.parse(raw.toString())
				this.handleClientMessage(ws, msg)
			} catch {
				ws.send(JSON.stringify({ type: 'error' }))
			}
		})

		ws.on('close', (code, _reason) => {
			clearInterval(ping)
			log.info('client disconnected', { ip, code, clients: this.wss.clients.size })
			this.broadcastViewers()
		})
	}

	private handleClientMessage(_ws: WebSocket, msg: WsInMessage) {
		// Future: handle chat messages, etc.
		log.debug('client message', { type: msg.type })
	}

	private broadcast(message: WsOutMessage) {
		const data = JSON.stringify(message)
		for (const client of this.wss.clients) {
			if (client.readyState === client.OPEN) {
				client.send(data)
			}
		}
	}

	private broadcastViewers() {
		this.broadcast({ type: 'viewers', count: this.wss.clients.size })
	}

	private async ensureSubscriptions() {
		if (this.subReady) return
		this.subReady = true // Mark early to prevent race

		try {
			const db = await getDb()
			log.info('starting SurrealDB live subscriptions')

			const liveResults = await Promise.all(
				TABLES.map(async (tableName) => {
					log.debug('subscribing to live table', { table: tableName })
					const live = await db.live(new Table(tableName))
					log.info('live subscription active', { table: tableName })
					return { tableName, sub: live }
				}),
			)

			this.subs = liveResults.map((r) => r.sub)

			// Process events from each subscription independently
			for (const { tableName, sub } of liveResults) {
				;(async () => {
					try {
						for await (const message of sub) {
							log.debug('live event', {
								table: tableName,
								action: message.action,
								recordId: String(message.recordId),
							})
							this.broadcast({
								type: 'live',
								table: tableName,
								action: message.action,
								record: normalizeRecordIds(message.value) as Record<string, unknown>,
							})
						}
						log.warning('live iterator ended unexpectedly', { table: tableName })
					} catch (err) {
						log.error('live query error ({table}): {error}', {
							table: tableName,
							error: err instanceof Error ? err.stack ?? err.message : JSON.stringify(err),
						})
					}
				})()
			}

			log.info('all live subscriptions active', { tables: TABLES.length })
		} catch (err) {
			log.error('subscription setup error: {error}', {
				error: err instanceof Error ? err.stack ?? err.message : JSON.stringify(err),
			})
			this.subReady = false // Allow retry
		}
	}

	async close() {
		log.info('closing WebSocket server')
		for (const client of this.wss.clients) {
			client.close(1001, 'server shutting down')
		}
		for (const sub of this.subs) {
			try {
				await sub.kill()
			} catch { /* ignore */ }
		}
		this.wss.close()
	}
}
