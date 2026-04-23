import { getDb } from '$lib/server/surreal'
import type { SeasonScore } from '$lib/server/types'
import { json } from '@sveltejs/kit'

export async function GET({ params }) {
	const { id } = params

	try {
		const db = await getDb()

		const [scores] = await db.query(
			'SELECT * FROM season_score WHERE season_id = $sid ORDER BY points DESC',
			{ sid: id as string },
		).collect<[SeasonScore[]]>()

		return json({ seasonId: id, scores })
	} catch (e) {
		console.error('Failed to fetch season scores:', e)
		return json({ seasonId: id, scores: [] }, { status: 500 })
	}
}
