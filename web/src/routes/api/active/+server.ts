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
		console.log(
			`[active] running query returned ${running.length} sessions`,
			running.length > 0
				? `id=${normalizeId((running[0] as any)?.id)} status=${(running[0] as any)?.status} season_id=${
					(running[0] as any)?.season_id
				}`
				: '',
		)
		if (sessions.length === 0) {
			// Fallback: return most recent session regardless of status
			// Also try without season_id filter to see if it's a filtering issue
			const [allRecent] = await db.query(
				`SELECT * FROM quiz_session ORDER BY started_at DESC LIMIT 5`,
			).collect<[QuizSession[]]>()
			console.log(
				`[active] all recent sessions (no filter):`,
				allRecent.map((s: any) => ({ id: normalizeId(s.id), status: s.status, season_id: s.season_id })),
			)
			const [recent] = await db.query(
				`SELECT * FROM quiz_session WHERE (season_id = NONE OR string::starts_with(season_id, $prefix)) ORDER BY started_at DESC LIMIT 1`,
				{ prefix },
			).collect<[QuizSession[]]>()
			sessions = recent
			console.log(
				`[active] no running sessions, fallback to recent:`,
				recent.length > 0
					? `id=${normalizeId((recent[0] as any)?.id)} status=${(recent[0] as any)?.status} season_id=${
						(recent[0] as any)?.season_id
					}`
					: 'none',
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
				`SELECT
				id,
				session_id,
				member_mid,
				points,
				reached_at,
				(SELECT kananame FROM member WHERE mid = $parent.member_mid LIMIT 1)[0].kananame as member_kananame,
				(SELECT nickname FROM member WHERE mid = $parent.member_mid LIMIT 1)[0].nickname as member_nickname,
				(SELECT classgroup FROM member WHERE mid = $parent.member_mid LIMIT 1)[0].classgroup as member_classgroup
				FROM live_score
				WHERE session_id = $sid
				ORDER BY points DESC`,
				{ sid },
			).collect<[LiveScore[]]>()
			scores = scoreResults.map((s) => normalizeSession(s as any) as LiveScore)

			// Also fetch member states for cooldown display
			const [msResults] = await db.query(
				`SELECT
				id,
				session_id,
				member_mid,
				cooldown_until,
				wrong_remaining,
				(SELECT kananame FROM member WHERE mid = $parent.member_mid LIMIT 1)[0].kananame as member_kananame,
				(SELECT nickname FROM member WHERE mid = $parent.member_mid LIMIT 1)[0].nickname as member_nickname
				FROM live_member_state
				WHERE session_id = $sid`,
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
