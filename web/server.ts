/**
 * Production server wrapper for adapter-node with WebSocket support.
 *
 * Usage:
 *   bun run build
 *   bun run server.ts
 *
 * Environment variables (same as adapter-node):
 *   PORT           - Port to listen on (default: 3000)
 *   HOST           - Host to bind (default: 0.0.0.0)
 *   SOCKET_PATH    - Unix socket path (overrides PORT/HOST)
 *   ORIGIN         - Public URL origin (e.g., https://kotaete.nipbang.id)
 *   INSTANCE_NAME  - Instance name for web_status record ID (default: 'default')
 */

import { createServer } from 'node:http'
import { getDb } from './src/lib/server/surreal'
import { KotaeteWsServer } from './src/lib/server/ws-handler'

// Dynamic import because the build output doesn't exist until `bun run build`
const { handler } = await import('./build/handler.js')

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'
const socketPath = process.env.SOCKET_PATH
const instanceName = process.env.INSTANCE_NAME ?? 'default'

// Create HTTP server with SvelteKit handler
const httpServer = createServer(handler)

// Attach WebSocket server
const wsServer = new KotaeteWsServer()
wsServer.attachUpgrade(httpServer)

// Web status heartbeat (15-second interval)
const WEB_HEARTBEAT_INTERVAL = 15_000
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

async function updateWebStatus(status: string): Promise<void> {
	console.log(`[heartbeat] updating web_status:${instanceName} status=${status}`)
	try {
		const db = await getDb()
		const [result] = await db.query(
			`UPSERT web_status:$recordId SET status = $status, last_heartbeat_at = time::now(), pid = $pid, started_at = started_at ?? time::now()`,
			{ recordId: instanceName, status, pid: process.pid },
		)
		console.log(`[heartbeat] web_status:${instanceName} updated`, result)
	} catch (err) {
		console.error(`[heartbeat] web_status:${instanceName} failed:`, err)
	}
}

async function markWebStopped(): Promise<void> {
	console.log(`[heartbeat] marking web_status:${instanceName} stopped`)
	try {
		const db = await getDb()
		await db.query(
			`UPSERT web_status:$recordId SET status = 'stopped', last_heartbeat_at = time::now()`,
			{ recordId: instanceName },
		)
		console.log(`[heartbeat] web_status:${instanceName} marked stopped`)
	} catch (err) {
		console.error(`[heartbeat] web_status:${instanceName} stop failed:`, err)
	}
}

// Graceful shutdown
async function shutdown(reason: string) {
	console.log(`[server] shutting down (${reason})`)
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer)
		heartbeatTimer = null
	}
	await markWebStopped()
	await wsServer.close()
	httpServer.close(() => {
		console.log('[server] closed')
		process.exit(0)
	})
	// Force shutdown after 30s
	setTimeout(() => {
		console.error('[server] forced shutdown after timeout')
		process.exit(1)
	}, 30_000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Start listening
if (socketPath) {
	httpServer.listen(socketPath, () => {
		console.log(`[server] instance: ${instanceName}`)
		console.log(`[server] listening on ${socketPath}`)
		void updateWebStatus('running')
		heartbeatTimer = setInterval(() => {
			void updateWebStatus('running')
		}, WEB_HEARTBEAT_INTERVAL)
	})
} else {
	httpServer.listen(port, host, () => {
		console.log(`[server] instance: ${instanceName}`)
		console.log(`[server] listening on http://${host}:${port}`)
		void updateWebStatus('running')
		heartbeatTimer = setInterval(() => {
			void updateWebStatus('running')
		}, WEB_HEARTBEAT_INTERVAL)
	})
}
