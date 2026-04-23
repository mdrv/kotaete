import { getDb } from '$lib/server/surreal'
import { json } from '@sveltejs/kit'

interface SeasonRecord {
	season_id: string
	caption: string | null
	group_id: string
	members: unknown
}

export async function GET() {
	try {
		const db = await getDb()

		const [seasons] = await db.query(
			"SELECT season_id, caption, group_id, members FROM season WHERE string::starts_with(season_id, 'kotaete-s') ORDER BY season_id DESC",
		).collect<[SeasonRecord[]]>()

		return json(seasons)
	} catch (e) {
		console.error('Failed to fetch seasons:', e)
		return json([], { status: 500 })
	}
}
