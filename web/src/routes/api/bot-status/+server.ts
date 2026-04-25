import { getDb } from '$lib/server/surreal'
import { json } from '@sveltejs/kit'

export async function GET() {
	try {
		const db = await getDb()

		const staleThreshold = 45_000 // 3 missed heartbeats at 15s interval
		type StatusRow = {
			id: { id: string }
			status: string
			last_heartbeat_at: string | null
			started_at: string | null
			pid: number | null
		}

		const [daemonResult, webResult] = await Promise.all([
			db.query<[StatusRow[]]>('SELECT id, status, last_heartbeat_at, started_at, pid FROM daemon_status:only'),
			db.query<[StatusRow[]]>('SELECT id, status, last_heartbeat_at, started_at, pid FROM web_status'),
		])

		function resolveStatus(result: [StatusRow[]] | undefined) {
			const row = result?.[0]?.[0]
			if (!row) {
				return {
					online: false,
					status: 'unknown' as const,
					lastHeartbeatAt: null as string | null,
					startedAt: null as string | null,
					pid: null as number | null,
				}
			}
			const lastHb = row.last_heartbeat_at ? new Date(row.last_heartbeat_at).getTime() : 0
			const online = row.status !== 'stopped' && (Date.now() - lastHb) < staleThreshold
			return {
				online,
				status: row.status,
				lastHeartbeatAt: row.last_heartbeat_at,
				startedAt: row.started_at,
				pid: row.pid,
			}
		}

		// Web: aggregate across all instances
		const webRows = webResult?.[0] ?? []
		const webOnline = webRows.some((row) => {
			const lastHb = row.last_heartbeat_at ? new Date(row.last_heartbeat_at).getTime() : 0
			return row.status !== 'stopped' && (Date.now() - lastHb) < staleThreshold
		})

		const webInstances = webRows.map((row) => {
			const lastHb = row.last_heartbeat_at ? new Date(row.last_heartbeat_at).getTime() : 0
			const online = row.status !== 'stopped' && (Date.now() - lastHb) < staleThreshold
			const name = typeof row.id === 'object' && 'id' in row.id ? row.id.id : String(row.id)
			return {
				name,
				online,
				status: row.status,
				lastHeartbeatAt: row.last_heartbeat_at,
				startedAt: row.started_at,
				pid: row.pid,
			}
		})

		return json({
			daemon: resolveStatus(daemonResult),
			web: { online: webOnline, instances: webInstances },
		})
	} catch {
		return json({
			daemon: { online: false, status: 'error', lastHeartbeatAt: null },
			web: { online: false, instances: [] },
		})
	}
}
