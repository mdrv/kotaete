export interface QuizSession {
	id: string
	group_id: string
	season_id: string | null
	job_id: string
	status: 'running' | 'finished' | 'stopped'
	started_at: string
	finished_at: string | null
	total_questions: number
	current_question: number | null
	current_round: number | null
	accepting_answers: boolean
	deadline_at: string | null
	quiz_dir: string | null
	first_round_at: string | null
}

export interface QuizEvent {
	id: string
	session_id: string
	group_id: string
	season_id: string | null
	event_type: string
	question_no: number | null
	member_mid: string | null
	member_kananame: string | null
	member_nickname: string | null
	member_classgroup: string | null
	data: Record<string, unknown>
	created_at: string
}

export interface LiveScore {
	id: string
	session_id: string
	member_mid: string
	member_kananame: string
	member_nickname: string
	member_classgroup: string
	points: number
	reached_at: string | null
}

export interface LiveMemberState {
	id: string
	session_id: string
	member_mid: string
	member_kananame: string
	member_nickname: string
	cooldown_until: string | null
	wrong_remaining: number | null
}

export interface SeasonScore {
	id: string
	season_id: string
	member_mid: string
	member_kananame: string
	member_nickname: string
	member_classgroup: string
	points: number
	reached_at: string | null
}
