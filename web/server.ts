/**
 * Production server wrapper for adapter-node with WebSocket support.
 *
 * ⚠️ This file is NOT used during `vite dev` — only runs via `bun run server.ts`.
 * Server-side features (heartbeat, SurrealDB, WebSocket) live in src/lib/server/
 * so they work in both dev and production.
 *
 * Usage:
 *   bun run build
 *   bun run server.ts
 *
 * Environment variables (same as adapter-node):
 *   PORT          - Port to listen on (default: 3000)
 *   HOST          - Host to bind (default: 0.0.0.0)
 *   SOCKET_PATH   - Unix socket path (overrides PORT/HOST)
 *   ORIGIN        - Public URL origin (e.g., https://kotaete.nipbang.id)
 */

import { createServer } from 'node:http'
import { stopHeartbeat } from './src/lib/server/surreal'
import { KotaeteWsServer } from './src/lib/server/ws-handler'

// Dynamic import because the build output doesn't exist until `bun run build`
const { handler } = await import('./build/handler.js')

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'
const socketPath = process.env.SOCKET_PATH

// Create HTTP server with SvelteKit handler
const httpServer = createServer(handler)

// Attach WebSocket server
const wsServer = new KotaeteWsServer()
wsServer.attachUpgrade(httpServer)

// Graceful shutdown
async function shutdown(reason: string) {
	console.log(`[server] shutting down (${reason})`)
	await stopHeartbeat()
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
		console.log(`[server] listening on ${socketPath}`)
	})
} else {
	httpServer.listen(port, host, () => {
		console.log(`[server] listening on http://${host}:${port}`)
	})
}
