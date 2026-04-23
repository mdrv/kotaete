import { getDb } from '$lib/server/surreal'
import type { QuizEvent } from '$lib/server/types'
import { json } from '@sveltejs/kit'

export async function GET({ params }) {
	const { sessionId } = params

	try {
		const db = await getDb()

		const [events] = await db.query(
			'SELECT * FROM quiz_event WHERE session_id = type::record($sid) ORDER BY created_at DESC LIMIT 50',
			{ sid: sessionId as string },
		).collect<[QuizEvent[]]>()

		return json({ events })
	} catch (e) {
		console.error('Failed to fetch events:', e)
		return json({ events: [] }, { status: 500 })
	}
}
