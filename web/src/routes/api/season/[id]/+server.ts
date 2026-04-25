import { getDb } from '$lib/server/surreal'
import type { SeasonScore } from '$lib/server/types'
import { json } from '@sveltejs/kit'

export async function GET({ params }: { params: { id: string } }) {
	const { id } = params

	try {
		const db = await getDb()

		const [scores] = await db.query(
			`SELECT
			id,
			season_id,
			mid as member_mid,
			points,
			reached_at,
			(SELECT kananame FROM member WHERE mid = $parent.mid LIMIT 1)[0].kananame as member_kananame,
			(SELECT nickname FROM member WHERE mid = $parent.mid LIMIT 1)[0].nickname as member_nickname,
			(SELECT classgroup FROM member WHERE mid = $parent.mid LIMIT 1)[0].classgroup as member_classgroup
			FROM season_score WHERE season_score.season_id = $sid ORDER BY points DESC`,
			{ sid: id as string },
		).collect<[SeasonScore[]]>()

		return json({ seasonId: id, scores })
	} catch (e) {
		console.error('Failed to fetch season scores:', e)
		return json({ seasonId: id, scores: [] }, { status: 500 })
	}
}
