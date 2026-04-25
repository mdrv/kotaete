import { getDb } from '$lib/server/surreal'
import type { SeasonScore } from '$lib/server/types'
import { json } from '@sveltejs/kit'

export async function GET({ params }: { params: { id: string } }) {
	const { id } = params

	try {
		const db = await getDb()

		const [scores] = await db.query(
			`SELECT
				season_score.id,
				season_score.season_id,
				season_score.mid as member_mid,
				season_score.points,
				season_score.reached_at,
				members.kananame as member_kananame,
				members.nickname as member_nickname,
				members.classgroup as member_classgroup
			FROM season_score JOIN members ON season_score.mid = members.mid WHERE season_score.season_id = $sid ORDER BY season_score.points DESC`,
			{ sid: id as string },
		).collect<[SeasonScore[]]>()

		return json({ seasonId: id, scores })
	} catch (e) {
		console.error('Failed to fetch season scores:', e)
		return json({ seasonId: id, scores: [] }, { status: 500 })
	}
}
