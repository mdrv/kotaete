import { getDb } from '$lib/server/surreal'
import type { LiveMemberState as LiveMemberStateType, LiveScore, QuizSession } from '$lib/server/types'
import { json } from '@sveltejs/kit'
import { RecordId } from 'surrealdb'

/** Normalize SurrealDB RecordId to just the record key (string) */
function normalizeId(id: unknown): string {
	if (id instanceof RecordId) return String(id.id)
	if (typeof id === 'string') {
		const idx = id.indexOf(':')
		return idx >= 0 ? id.slice(idx + 1) : id
	}
	return String(id)
}

function normalizeSession<T extends Record<string, unknown>>(record: T): T {
	if ('id' in record) {
		return { ...record, id: normalizeId(record.id) }
	}
	return record
}

export async function GET({ url }: { url: URL }) {
	const prefix = url.searchParams.get('prefix') ?? 'kotaete-s'
	try {
		const db = await getDb()

		// First try running sessions, then fallback to any recent session
		const [running] = await db.query(
			`SELECT * FROM quiz_session WHERE status = 'running' AND (season_id = NONE OR string::starts_with(season_id, $prefix)) ORDER BY started_at DESC LIMIT 1`,
			{ prefix },
		).collect<[QuizSession[]]>()

		let sessions = running
		if (sessions.length === 0) {
			// Fallback: return most recent session regardless of status
			const [recent] = await db.query(
				`SELECT * FROM quiz_session WHERE (season_id = NONE OR string::starts_with(season_id, $prefix)) ORDER BY started_at DESC LIMIT 1`,
				{ prefix },
			).collect<[QuizSession[]]>()
			sessions = recent
			console.log(
				`[active] no running sessions, fallback to recent:`,
				recent.length > 0 ? `id=${normalizeId((recent[0] as any)?.id)} status=${(recent[0] as any)?.status}` : 'none',
			)
		}

		const session = sessions[0] ? normalizeSession(sessions[0] as any) as QuizSession : null
		let scores: LiveScore[] = []
		let memberStateList: LiveMemberStateType[] = []

		console.log(
			`[active] prefix=${prefix} sessions_found=${sessions.length}`,
			session
				? `session_id=${session.id} status=${(sessions[0] as any)?.status} season_id=${(sessions[0] as any)?.season_id}`
				: 'null',
		)

		if (session) {
			const sid = new RecordId('quiz_session', session.id)
			console.log(`[active] querying live_score with sid=`, sid)
			const [scoreResults] = await db.query(
				'SELECT * FROM live_score WHERE session_id = $sid ORDER BY points DESC',
				{ sid },
			).collect<[LiveScore[]]>()
			scores = scoreResults.map((s) => normalizeSession(s as any) as LiveScore)

			// Also fetch member states for cooldown display
			const [msResults] = await db.query(
				'SELECT * FROM live_member_state WHERE session_id = $sid',
				{ sid },
			).collect<[LiveMemberStateType[]]>()
			memberStateList = msResults.map((s) => normalizeSession(s as any) as LiveMemberStateType)
		}

		return json({ session, scores, memberStates: memberStateList })
	} catch (e) {
		console.error('Failed to fetch active session:', e)
		return json({ session: null, scores: [] }, { status: 500 })
	}
}
