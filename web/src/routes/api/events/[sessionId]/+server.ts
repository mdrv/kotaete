import { getDb } from '$lib/server/surreal'
import type { QuizEvent } from '$lib/server/types'
import { json } from '@sveltejs/kit'
import { RecordId } from 'surrealdb'

function extractKey(id: string): string {
	const idx = id.indexOf(':')
	return idx >= 0 ? id.slice(idx + 1) : id
}

export async function GET({ params }: { params: { sessionId: string } }) {
	const { sessionId } = params
	const key = extractKey(sessionId)

	try {
		const db = await getDb()
		const sid = new RecordId('quiz_session', key)

		const [events] = await db.query(
			`SELECT quiz_event.id, quiz_event.session_id, quiz_event.event_type, quiz_event.question_no, quiz_event.member_mid, quiz_event.data, quiz_event.created_at, members.kananame as member_kananame, members.nickname as member_nickname, members.classgroup as member_classgroup FROM quiz_event LEFT JOIN members ON quiz_event.member_mid = members.mid WHERE quiz_event.session_id = $sid ORDER BY quiz_event.created_at DESC LIMIT 50`,
			{ sid },
		).collect<[QuizEvent[]]>()

		return json({ events })
	} catch (e) {
		console.error('Failed to fetch events:', e)
		return json({ events: [] }, { status: 500 })
	}
}
