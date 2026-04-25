import { getDb } from '$lib/server/surreal'
import { json } from '@sveltejs/kit'

export async function GET() {
	try {
		const db = await getDb()

		const [status] = await db.query<
			[{ status: string; last_heartbeat_at: string | null; started_at: string | null; pid: number | null }[]]
		>(
			`SELECT status, last_heartbeat_at, started_at, pid FROM daemon_status:only`,
		)

		const row = status?.[0]
		if (!row) {
			return json({ online: false, status: 'unknown', lastHeartbeatAt: null })
		}

		const lastHb = row.last_heartbeat_at ? new Date(row.last_heartbeat_at).getTime() : 0
		const staleThreshold = 15_000 // 3 missed heartbeats at 5s interval
		const online = row.status !== 'stopped' && (Date.now() - lastHb) < staleThreshold

		return json({
			online,
			status: row.status,
			lastHeartbeatAt: row.last_heartbeat_at,
			startedAt: row.started_at,
			pid: row.pid,
		})
	} catch (err) {
		return json({ online: false, status: 'error', lastHeartbeatAt: null })
	}
}
