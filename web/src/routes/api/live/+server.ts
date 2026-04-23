import { getDb } from '$lib/server/surreal'
import { Table } from 'surrealdb'
import type { LiveMessage, LiveSubscription } from 'surrealdb'
import type { RequestHandler } from './$types'

const TABLES = ['quiz_event', 'live_score', 'live_member_state', 'quiz_session'] as const

export const GET: RequestHandler = async ({ request }) => {
	const signal = request.signal
	const db = await getDb()

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder()

			const send = (event: string, data: unknown) => {
				controller.enqueue(
					encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
				)
			}

			const heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': heartbeat\n\n'))
				} catch {
					clearInterval(heartbeat)
				}
			}, 30_000)

			const subscriptions: LiveSubscription[] = []

			try {
				for (const tableName of TABLES) {
					const live = await db.live(new Table(tableName))
					subscriptions.push(live)
				}

				const tasks = subscriptions.map(async (sub, i) => {
					const tableName = TABLES[i]
					try {
						for await (const message of sub) {
							if (signal.aborted) break
							send(tableName, {
								action: message.action,
								record: message.value,
							})
						}
					} catch (err) {
						if (!signal.aborted) console.error(`Live query error for ${tableName}:`, err)
					}
				})

				await Promise.race([
					Promise.all(tasks),
					new Promise((resolve) => {
						signal.addEventListener('abort', resolve, { once: true })
					}),
				])
			} finally {
				clearInterval(heartbeat)
				for (const sub of subscriptions) {
					try {
						await sub.kill()
					} catch {
						// already cleaned up
					}
				}
				try {
					controller.close()
				} catch {
					// already closed
				}
			}
		},
	})

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'Access-Control-Allow-Origin': '*',
		},
	})
}
