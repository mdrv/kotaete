import { getDb } from '$lib/server/surreal'
import type { LiveScore, QuizSession } from '$lib/server/types'
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

		const [sessions] = await db.query(
			`SELECT * FROM quiz_session WHERE status = 'running' AND (season_id = NONE OR string::starts_with(season_id, $prefix)) ORDER BY started_at DESC LIMIT 1`,
			{ prefix },
		).collect<[QuizSession[]]>()

		const session = sessions[0] ? normalizeSession(sessions[0] as any) as QuizSession : null
		let scores: LiveScore[] = []

		if (session) {
			const sid = new RecordId('quiz_session', session.id)
			const [scoreResults] = await db.query(
				'SELECT * FROM live_score WHERE session_id = $sid ORDER BY points DESC',
				{ sid },
			).collect<[LiveScore[]]>()
			scores = scoreResults.map((s) => normalizeSession(s as any) as LiveScore)
		}

		return json({ session, scores })
	} catch (e) {
		console.error('Failed to fetch active session:', e)
		return json({ session: null, scores: [] }, { status: 500 })
	}
}
