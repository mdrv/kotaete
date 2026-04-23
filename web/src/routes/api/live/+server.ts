import { getLogger } from '$lib/server/logger'
import { getDb } from '$lib/server/surreal'
import { type LiveSubscription, Table } from 'surrealdb'
import type { RequestHandler } from './$types'

const TABLES = ['quiz_event', 'live_score', 'live_member_state', 'quiz_session', 'season_score'] as const
const log = getLogger(['kotaete', 'web', 'sse'])

export const GET: RequestHandler = async ({ request }) => {
	const signal = request.signal
	log.info('new SSE connection')

	const db = await getDb()
	log.debug('db connection ready')

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
					log.warning('send failed', { event, error: err instanceof Error ? err.message : String(err) })
					closed = true
				}
			}

			const heartbeat = setInterval(() => {
				if (closed) {
					clearInterval(heartbeat)
					return
				}
				try {
					controller.enqueue(encoder.encode(': heartbeat\n\n'))
				} catch {
					clearInterval(heartbeat)
				}
			}, 30_000)

			const subs: LiveSubscription[] = []

			try {
				// Subscribe to all tables in parallel
				const liveResults = await Promise.all(
					TABLES.map(async (tableName) => {
						log.debug('calling db.live()', { table: tableName })
						const live = await db.live(new Table(tableName))
						log.info('live subscription created', { table: tableName })
						return live
					}),
				)
				subs.push(...liveResults)

				log.info('all subscriptions active, entering event loop')

				// Process events from all subscriptions concurrently.
				// Each subscription runs in its own loop so one ending
				// doesn't collapse the others.
				const tasks = subs.map((sub, i) => {
					const tableName = TABLES[i]
					return (async () => {
						try {
							for await (const message of sub) {
								if (signal.aborted) break
								log.debug('live event', {
									table: tableName,
									action: message.action,
									recordId: String(message.recordId),
								})
								send(tableName, {
									action: message.action,
									record: message.value,
								})
							}
							if (!signal.aborted) {
								log.warning('live iterator ended unexpectedly', { table: tableName })
							}
						} catch (err) {
							console.error(`[SSE] LIVE ERROR (${tableName}):`, err)
							log.error('live query error ({table}): {error}', {
								table: tableName,
								error: err instanceof Error ? err.stack ?? err.message : JSON.stringify(err),
							})
						}
					})()
				})

				// Wait until client disconnects or all tasks finish
				await Promise.race([
					Promise.all(tasks),
					new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => resolve(), { once: true })
					}),
				])
			} catch (err) {
				console.error('[SSE] SETUP ERROR:', err)
				log.error('SSE setup error: {error}', {
					error: err instanceof Error ? err.stack ?? err.message : JSON.stringify(err),
				})
			} finally {
				closed = true
				clearInterval(heartbeat)
				log.info('cleaning up SSE', { subs: subs.length })
				for (const sub of subs) {
					try {
						await sub.kill()
					} catch { /* ignore */ }
				}
				try {
					controller.close()
				} catch { /* already closed */ }
				log.info('SSE closed')
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
