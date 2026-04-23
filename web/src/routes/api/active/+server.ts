import { getDb } from '$lib/server/surreal'
import type { LiveScore, QuizSession } from '$lib/server/types'
import { json } from '@sveltejs/kit'

export async function GET() {
	try {
		const db = await getDb()

		const [sessions] = await db.query(
			"SELECT * FROM quiz_session WHERE status = 'running' ORDER BY started_at DESC LIMIT 1",
		).collect<[QuizSession[]]>()

		const session = sessions[0] ?? null
		let scores: LiveScore[] = []

		if (session) {
			const [scoreResults] = await db.query(
				'SELECT * FROM live_score WHERE session_id = $sid ORDER BY points DESC',
				{ sid: session.id },
			).collect<[LiveScore[]]>()
			scores = scoreResults
		}

		return json({ session, scores })
	} catch (e) {
		console.error('Failed to fetch active session:', e)
		return json({ session: null, scores: [] }, { status: 500 })
	}
}
