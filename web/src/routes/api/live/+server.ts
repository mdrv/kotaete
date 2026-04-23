import { getDb } from '$lib/server/surreal'
import { getLogger } from '$lib/server/logger'
import { Table, type LiveSubscription } from 'surrealdb'
import type { RequestHandler } from './$types'

const TABLES = ['quiz_event', 'live_score', 'live_member_state', 'quiz_session'] as const
const log = getLogger(['kotaete', 'web', 'sse'])

export const GET: RequestHandler = async ({ request }) => {
	const signal = request.signal
	const db = await getDb()
	const connId = crypto.randomUUID().slice(0, 8)
	log.info('new SSE connection', { connId })

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder()
			let closed = false

			const send = (event: string, data: unknown) => {
				if (closed) return
				try {
					controller.enqueue(
						encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
					)
				} catch (err) {
					log.warning('send failed, closing', { connId, event, error: String(err) })
					closed = true
				}
			}

			const heartbeat = setInterval(() => {
				if (closed) { clearInterval(heartbeat); return }
				try {
					controller.enqueue(encoder.encode(': heartbeat\n\n'))
				} catch {
					clearInterval(heartbeat)
				}
			}, 30_000)

			const unsubFns: (() => void)[] = []
			const subs: LiveSubscription[] = []

			try {
				for (const tableName of TABLES) {
					log.debug('subscribing to live table', { connId, table: tableName })
					const live = await db.live(new Table(tableName))
					log.debug('live subscription created', { connId, table: tableName })

					const unsub = live.subscribe((message) => {
						if (signal.aborted || closed) return
						log.debug('live event', {
							connId,
							table: tableName,
							action: message.action,
							recordId: String(message.recordId),
						})
						send(tableName, {
							action: message.action,
							record: message.value,
						})
					})
					unsubFns.push(unsub)
					subs.push(live)
				}

				log.info('all live subscriptions active', { connId, tables: TABLES.length })

				// Block until abort — subscribe callbacks don't "end"
				await new Promise<void>((resolve) => {
					signal.addEventListener('abort', () => {
						log.info('abort signal received', { connId })
						resolve()
					}, { once: true })
				})
			} catch (err) {
				log.error('SSE error', { connId, error: String(err) })
			} finally {
				closed = true
				clearInterval(heartbeat)
				log.info('cleaning up SSE connection', { connId, unsubCount: unsubFns.length })
				for (const unsub of unsubFns) {
					try { unsub() } catch { /* ignore */ }
				}
				// Kill live queries to free SurrealDB resources
				for (const sub of subs) {
					try { await sub.kill() } catch { /* ignore */ }
				}
				try { controller.close() } catch { /* already closed */ }
				log.info('SSE connection closed', { connId })
			}
		},
	})

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
			'Access-Control-Allow-Origin': '*',
		},
	})
}