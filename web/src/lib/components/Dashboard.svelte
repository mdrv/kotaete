<script lang='ts'>
	import { browser } from '$app/environment'
	import { connectLive } from '$lib/live-connection'
	import type {
		LiveMemberState as LiveMemberStateType,
		LiveScore,
		QuizEvent,
		QuizSession,
		SeasonScore,
	} from '$lib/types'
	import { onDestroy, onMount } from 'svelte'

	let { seasonPrefix = 'kotaete-s' }: { seasonPrefix?: string } = $props()

	// ── State ──────────────────────────────────────────────
	let session = $state<QuizSession | null>(null)
	let scores = $state<LiveScore[]>([])
	let memberCache = $state<
		Map<string, { kananame: string; nickname: string; classgroup: string }>
	>(new Map())
	let events = $state<QuizEvent[]>([])
	let seasonScores = $state<SeasonScore[]>([])
	let seasonInfo = $state<{ id: string; caption: string | null } | null>(null)
	let seasons = $state<{ season_id: string; caption: string | null }[]>([])
	let connected = $state(false)
	let botOnline = $state<boolean | null>(null) // null = not yet checked
	let botStatusInterval: ReturnType<typeof setInterval> | null = null
	let viewers = $state(0)
	let timeRemaining = $state(0)
	let imageError = $state(false)
	let showZeroPts = $state(false)
	let selectedSeasonId = $state<string | null>(null)
	let theme = $state<'dark' | 'light'>('dark')
	let memberStates = $state<Map<string, LiveMemberStateType>>(new Map())
	let now = $state(Date.now())
	let clockOffset = $state(0) // server time - local time (ms)

	// ── Derived ────────────────────────────────────────────
	let displayMode = $derived.by(() => {
		if (!session) return 'idle'
		// Finished/stopped session — always show final state
		if (session.status === 'finished' || session.status === 'stopped') {
			return 'finished'
		}
		// Session state is source of truth — show question immediately when accepting
		if (session.accepting_answers && session.current_question != null) {
			return 'question'
		}
		// Intro mode: session running, no question yet, first_round_at in the future
		if (
			session.status === 'running' && !session.accepting_answers
			&& session.current_question == null
		) {
			const fra = session.first_round_at
			if (fra && new Date(fra).getTime() > now) {
				return 'intro'
			}
		}
		// Otherwise show result from latest event
		const latest = events[0]
		if (latest) {
			if (latest.event_type === 'answer_correct') return 'winner'
			if (latest.event_type === 'timeout') return 'timeout'
		}
		return 'idle'
	})

	let isGodStage = $derived(
		events.some((e) => e.event_type === 'god_stage_announced'),
	)

	let winnerInfo = $derived.by(() => {
		const e = events[0]
		if (!e || e.event_type !== 'answer_correct') return null
		const name = e.member_kananame ?? '???'
		const cg = e.member_classgroup
		const displayName = cg ? `${name} (${cg})` : name
		const pts = (e.data.totalGained as number) ?? (e.data.gained as number) ?? 0
		const answer = (e.data.matchedAnswer as string)
			?? (e.data.matched_answer as string) ?? null
		return { displayName, points: pts, answer, questionNo: e.question_no }
	})

	let timeoutInfo = $derived.by(() => {
		const e = events[0]
		if (!e || e.event_type !== 'timeout') return null
		const answers = e.data.answers as Record<string, string> | undefined
		return { questionNo: e.question_no, answers }
	})

	let countdownText = $derived.by(() => {
		const mins = Math.floor(timeRemaining / 60)
		const secs = timeRemaining % 60
		return `${mins}:${secs.toString().padStart(2, '0')}`
	})

	// Intro countdown: time until first question (first_round_at)
	let introCountdownText = $derived.by(() => {
		const fra = session?.first_round_at
		if (!fra) return null
		const target = new Date(fra).getTime()
		const diff = Math.max(0, Math.floor((target - now) / 1000))
		if (diff <= 0) return null
		const hrs = Math.floor(diff / 3600)
		const mins = Math.floor((diff % 3600) / 60)
		const secs = diff % 60
		const pad = (n: number) => n.toString().padStart(2, '0')
		if (hrs > 0) return `${hrs}:${pad(mins)}:${pad(secs)}`
		return `${mins}:${pad(secs)}`
	})

	let questionImageUrl = $derived.by(() => {
		if (!session?.id || session.current_question == null) return ''
		return `/api/image/${
			encodeURIComponent(session.id)
		}/${session.current_question}`
	})

	let sortedScores = $derived.by(() =>
		[...scores].sort((a, b) => {
			if (b.points !== a.points) return b.points - a.points
			if (a.reached_at && b.reached_at) {
				return a.reached_at.localeCompare(b.reached_at)
			}
			const cgDiff = classgroupCompare(a.member_classgroup, b.member_classgroup)
			if (cgDiff !== 0) return cgDiff
			return (a.member_kananame ?? '').localeCompare(
				b.member_kananame ?? '',
				'ja',
			)
		})
	)

	let topSeasonScores = $derived.by(() => {
		const sorted = [...seasonScores].sort((a, b) => {
			if (b.points !== a.points) return b.points - a.points
			const aRa = a.reached_at
			const bRa = b.reached_at
			const cgDiff = classgroupCompare(a.member_classgroup, b.member_classgroup)
			if (cgDiff !== 0) return cgDiff
			return (a.member_kananame ?? '').localeCompare(
				b.member_kananame ?? '',
				'ja',
			)
		})
		return showZeroPts
			? sorted.slice(0, 30)
			: sorted.filter((s) => s.points > 0).slice(0, 30)
	})

	// ── Helpers ────────────────────────────────────────────

	// ── Clock ──────────────────────────────────────────────
	/** Server-adjusted current time in ms */
	function serverNow(): number {
		return Date.now() + clockOffset
	}

	// ── Theme ──────────────────────────────────────────────
	function applyTheme(t: 'dark' | 'light') {
		if (!browser) return
		document.documentElement.classList.toggle('light', t === 'light')
		localStorage.setItem('kotaete-theme', t)
	}

	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark'
		applyTheme(theme)
	}

	function classgroupCompare(
		a: string | null | undefined,
		b: string | null | undefined,
	): number {
		if (!a && !b) return 0
		if (!a) return 1
		if (!b) return -1
		// Natural sort: extract leading number, then compare remainder alphabetically
		const numA = parseInt(a, 10)
		const numB = parseInt(b, 10)
		if (!isNaN(numA) && !isNaN(numB)) {
			if (numA !== numB) return numA - numB
			// Same number — compare suffix alphabetically
			return a.replace(/^\d+/, '').localeCompare(b.replace(/^\d+/, ''))
		}
		if (!isNaN(numA)) return -1
		if (!isNaN(numB)) return 1
		return a.localeCompare(b)
	}

	function memberDisplay(
		name: string | null | undefined,
		cg: string | null | undefined,
	): string {
		if (!name) return '???'
		return cg ? `${name} (${cg})` : name
	}

	function formatEvent(evt: QuizEvent): { text: string; color: string } {
		const name = memberDisplay(evt.member_kananame, evt.member_classgroup)
		const qNo = evt.question_no

		switch (evt.event_type) {
			case 'answer_correct': {
				const pts = (evt.data.totalGained as number)
					?? (evt.data.gained as number) ?? 0
				const answer = (evt.data.matchedAnswer as string)
					?? (evt.data.matched_answer as string) ?? null
				const suffix = answer ? ` +${pts}pts (${answer})` : ` +${pts}pts`
				return {
					text: `✅ ${name}${suffix}`,
					color: 'var(--accent-green)',
				}
			}
			case 'answer_wrong': {
				const remaining = (evt.data.remainingChances as number) ?? 0
				const emojis = ['🙈', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣']
				const emoji = emojis[remaining + 1] ?? `${remaining + 1}`
				const answerText = evt.data.answerText as string | undefined
				const suffix = answerText ? `${answerText}` : 'wrong answer'
				return {
					text: `${emoji} ${name} — ${suffix}`,
					color: 'var(--accent-orange)',
				}
			}
			case 'timeout':
				return {
					text: qNo ? `⏰ Q${qNo} timed out` : '⏰ Timed out',
					color: 'var(--text-secondary)',
				}
			case 'question_asked':
				return {
					text: qNo ? `📝 Q${qNo} asked` : '📝 New question',
					color: 'var(--accent-blue)',
				}
			case 'god_stage_announced':
				return {
					text: '🌈 GOD STAGE incoming!',
					color: 'var(--accent-red)',
				}
			case 'quiz_finished':
				return {
					text: '🏁 QUIZ END!',
					color: 'var(--accent-green)',
				}
			case 'round_break':
				return {
					text: '☕ Round break',
					color: 'var(--text-secondary)',
				}
			case 'resumed':
				return {
					text: '🔄 Quiz resumed',
					color: 'var(--accent-blue)',
				}
			case 'cooldown':
				return {
					text: `🧊 ${name} — cooldown`,
					color: 'var(--text-secondary)',
				}
			case 'special_duplicate':
				return {
					text: `🪞 ${name} — duplicate answer`,
					color: 'var(--accent-orange)',
				}
			case 'god_stage_asked':
				return {
					text: qNo ? `⚡ Q${qNo} (神) asked` : '⚡ GOD STAGE asked',
					color: 'var(--accent-red)',
				}
			default:
				return {
					text: `📌 ${evt.event_type}`,
					color: 'var(--text-secondary)',
				}
		}
	}

	// ── SSE Handler ────────────────────────────────────────
	function matchesSeason(record: Record<string, unknown>): boolean {
		const sid = record.season_id as string | null | undefined
		if (!sid) return true // sessions without season_id are always shown
		return sid.startsWith(seasonPrefix)
	}

	function normalizeRecordId(id: unknown): string {
		const s = String(id)
		const idx = s.indexOf(':')
		return idx >= 0 ? s.slice(idx + 1) : s
	}

	function extractTimestamp(input: unknown): string | null {
		if (typeof input === 'string') {
			const trimmed = input.trim()
			if (trimmed.length === 0) return null
			const surrealDatetime = trimmed.match(/^d'(.+)'$/)
			if (surrealDatetime?.[1]) return surrealDatetime[1]
			if (/^\d+$/.test(trimmed)) return new Date(Number(trimmed)).toISOString()
			return trimmed
		}
		if (typeof input === 'number' && Number.isFinite(input)) {
			return new Date(input).toISOString()
		}
		if (input instanceof Date) return input.toISOString()
		if (input && typeof input === 'object') {
			const record = input as Record<string, unknown>
			if (record.$datetime != null) return extractTimestamp(record.$datetime)
			if (record.value != null) return extractTimestamp(record.value)
		}
		return null
	}

	function formatHm(input: unknown): string {
		const raw = extractTimestamp(input)
		if (!raw) return ''
		const date = new Date(raw)
		if (Number.isNaN(date.getTime())) return ''
		return date.toLocaleTimeString('id-ID', {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		})
	}

	function normalizeIncomingEvent(record: Record<string, unknown>): QuizEvent {
		const member = memberCache.get(record.member_mid as string)
		const extractedCreatedAt = extractTimestamp(record.created_at)
		const createdAt = extractedCreatedAt
			&& !Number.isNaN(new Date(extractedCreatedAt).getTime())
			? extractedCreatedAt
			: new Date().toISOString()
		return {
			...(record as unknown as QuizEvent),
			id: normalizeRecordId(record.id),
			session_id: normalizeRecordId(record.session_id),
			created_at: createdAt,
			member_kananame: member?.kananame ?? (record.member_kananame as string | null) ?? null,
			member_nickname: member?.nickname ?? (record.member_nickname as string | null) ?? null,
			member_classgroup: member?.classgroup ?? (record.member_classgroup as string | null) ?? null,
		}
	}

	// ── Score Refresh (REST fallback when SSE live_score fails) ──
	let scoreRefreshTimer: ReturnType<typeof setTimeout> | null = null

	function scheduleScoreRefresh() {
		if (scoreRefreshTimer) return
		scoreRefreshTimer = setTimeout(async () => {
			scoreRefreshTimer = null
			try {
				const res = await fetch(
					`/api/active?prefix=${encodeURIComponent(seasonPrefix)}`,
				)
				const data = await res.json()
				if (data.session) {
					session = data.session
					scores = data.scores ?? []
					// Refresh member states for cooldown display
					if (data.memberStates?.length) {
						const msMap = new Map<string, LiveMemberStateType>()
						for (const ms of data.memberStates as LiveMemberStateType[]) {
							if (ms.member_mid) msMap.set(ms.member_mid, ms)
						}
						memberStates = msMap
					}
					console.debug(
						'[refresh] updated scores:',
						scores.length,
						'memberStates:',
						memberStates.size,
					)
				} else {
					console.debug('[refresh] no session from API (quiz not running?)')
				}
				// Also refresh season scores if a season is selected
				if (seasonInfo) {
					const seasonRes = await fetch(
						`/api/season/${encodeURIComponent(seasonInfo.id)}`,
					)
					const seasonData = await seasonRes.json()
					seasonScores = seasonData.scores ?? []
				}
			} catch (e) {
				console.error('[refresh] failed:', e)
			}
		}, 500)
	}

	async function refreshOnReconnect() {
		try {
			const res = await fetch(
				`/api/active?prefix=${encodeURIComponent(seasonPrefix)}`,
			)
			const data = await res.json()
			if (data.session) {
				const newId = String(data.session.id)
				const oldId = session ? String(session.id) : null
				if (newId !== oldId) {
					// Session changed — full reset
					console.debug('[reconnect] session changed:', oldId, '→', newId)
					session = data.session
					scores = data.scores ?? []
					events = []
					memberStates = new Map()
					imageError = false
					tryFetchEvents(newId)
				} else {
					// Same session — just refresh scores
					session = data.session
					scores = data.scores ?? []
					if (data.memberStates?.length) {
						const msMap = new Map<string, LiveMemberStateType>()
						for (const ms of data.memberStates as LiveMemberStateType[]) {
							if (ms.member_mid) msMap.set(ms.member_mid, ms)
						}
						memberStates = msMap
					}
				}
			}
		} catch (e) {
			console.error('[reconnect] refresh failed:', e)
		}
	}

	async function tryFetchEvents(sessionId: string) {
		try {
			const eventsRes = await fetch(
				`/api/events/${encodeURIComponent(sessionId)}`,
			)
			const eventsData = await eventsRes.json()
			if (eventsData.events?.length) {
				events = (eventsData.events as unknown[])
					.filter((evt): evt is Record<string, unknown> =>
						evt != null && typeof evt === 'object'
					)
					.map((evt) => normalizeIncomingEvent(evt))
					.slice(0, 20)
				console.debug(
					'[SSE] fetched events for session',
					sessionId,
					events.length,
				)
			}
		} catch (e) {
			console.error('[SSE] failed to fetch events:', e)
		}
	}

	function matchesSession(record: Record<string, unknown>): boolean {
		if (!session) {
			// No session loaded yet — try to fetch from REST so future events match
			console.debug('[WS] matchesSession: no session, triggering refresh')
			scheduleScoreRefresh()
			return false
		}
		const recSessionId = normalizeRecordId(record.session_id ?? record.id)
		const match = recSessionId === String(session.id)
		if (!match) {
			console.debug('[WS] matchesSession: mismatch', {
				recSessionId,
				sessionId: session.id,
			})
		}
		return match
	}

	function handleLiveEvent(
		table: string,
		action: string,
		record: Record<string, unknown>,
	) {
		console.debug('[SSE] handleLiveEvent', {
			table,
			action,
			id: String(record.id),
		})
		switch (table) {
			case 'quiz_session':
				if (action === 'UPDATE' || action === 'CREATE') {
					if (!matchesSeason(record)) break
					const norm = {
						...record,
						id: normalizeRecordId(record.id),
					} as Record<string, unknown>
					const newStatus = norm.status as string | undefined
					const existingSession = session
					const isSameSession = existingSession
						&& normalizeRecordId(norm.id) === String(existingSession.id)

					if (newStatus && newStatus !== 'running' && isSameSession) {
						// Session we were tracking transitioned to non-running — keep showing final state
						console.debug(
							'[SSE] quiz session ended:',
							newStatus,
							'(keeping final state)',
						)
						session = { ...existingSession, ...norm } as unknown as QuizSession
						// Don't clear scores/events — keep final results visible
						// until a new session starts (handled in new-session path)
					} else {
						// New session or running update
						if (!existingSession || !isSameSession) {
							// Brand new session — clear stale data immediately
							console.debug(
								'[SSE] new session detected, fetching events/scores',
								{ id: norm.id, status: newStatus },
							)
							session = { ...norm } as unknown as QuizSession
							scores = []
							events = []
							memberStates = new Map()
							imageError = false
							// Cancel any pending cleanup timer from previous session
							if (scoreRefreshTimer) {
								clearTimeout(scoreRefreshTimer)
								scoreRefreshTimer = null
							}
							scheduleScoreRefresh()
							tryFetchEvents(normalizeRecordId(norm.id))
						} else {
							// Same session update — merge fields
							session = { ...session!, ...norm } as unknown as QuizSession
							imageError = false
							// Refresh scores on significant state changes
							scheduleScoreRefresh()
						}
					}
				}
				if (action === 'DELETE') {
					if (!matchesSession(record)) break
					session = null
					scores = []
					events = []
				}
				break
			case 'quiz_event':
				if (action === 'CREATE') {
					if (!matchesSession(record)) break
					const normEvent = normalizeIncomingEvent(record)
					events = [normEvent as unknown as QuizEvent, ...events].slice(0, 20)
					// Fallback: refresh scores via REST on quiz events
					// (live_score SSE may not fire due to SurrealDB live query issues)
					scheduleScoreRefresh()
				}
				break
			case 'live_score':
				if (action === 'CREATE' || action === 'UPDATE') {
					if (!matchesSession(record)) break
					console.debug('[SSE] live_score matched, adding', {
						mid: record.member_mid,
						points: record.points,
					})
					const scoreMember = memberCache.get(record.member_mid as string)
					const normScore = {
						...record,
						id: normalizeRecordId(record.id),
						session_id: normalizeRecordId(record.session_id),
						member_kananame: scoreMember?.kananame ?? record.member_kananame
							?? '',
						member_nickname: scoreMember?.nickname ?? record.member_nickname
							?? '',
						member_classgroup: scoreMember?.classgroup
							?? record.member_classgroup ?? '',
					} as unknown as LiveScore
					const idx = scores.findIndex((s) => s.id === normScore.id)
					if (idx >= 0) {
						scores = scores.map((s, i) => (i === idx ? normScore : s))
					} else {
						scores = [...scores, normScore]
					}
				}
				break
			case 'live_member_state':
				if (action === 'CREATE' || action === 'UPDATE') {
					if (!matchesSession(record)) break
					const mid = record.member_mid as string
					const stateMember = memberCache.get(mid)
					const normState = {
						...record,
						id: normalizeRecordId(record.id),
						session_id: normalizeRecordId(record.session_id),
						member_kananame: stateMember?.kananame ?? record.member_kananame
							?? '',
						member_nickname: stateMember?.nickname ?? record.member_nickname
							?? '',
					} as unknown as LiveMemberStateType
					console.debug('[WS] member_state update:', {
						mid,
						cd: normState.cooldown_until,
						wr: normState.wrong_remaining,
					})
					const next = new Map(memberStates)
					next.set(mid, normState)
					memberStates = next
				}
				if (action === 'DELETE') {
					const mid = record.member_mid as string
					if (mid) {
						const next = new Map(memberStates)
						next.delete(mid)
						memberStates = next
					}
				}
				break
			case 'season_score':
				if (action === 'CREATE' || action === 'UPDATE') {
					if (!matchesSeason(record)) break
					console.debug('[SSE] season_score matched', {
						season_id: record.season_id,
						mid: record.mid,
						points: record.points,
					})
					// Reload full season scores from REST (joins member data from members table)
					if (seasonInfo && record.season_id === seasonInfo.id) {
						loadSeasonScores(seasonInfo.id)
					}
				}
				if (action === 'DELETE') {
					if (seasonInfo && record.season_id === seasonInfo.id) {
						loadSeasonScores(seasonInfo.id)
					}
				}
				break
		}
	}

	// ── Timer Effect ───────────────────────────────────────
	$effect(() => {
		const deadline = session?.deadline_at
		if (!deadline) {
			timeRemaining = 0
			return () => {}
		}

		const update = () => {
			const remaining = new Date(deadline).getTime() - serverNow()
			timeRemaining = Math.max(0, Math.floor(remaining / 1000))
		}
		update()
		const interval = setInterval(update, 1000)
		return () => clearInterval(interval)
	})

	// ── Debug: log memberStates changes ──
	$effect(() => {
		if (memberStates.size === 0) return
		for (const [mid, ms] of memberStates) {
			if (ms.cooldown_until) {
				console.debug('[dashboard] memberState:', {
					mid,
					cd: ms.cooldown_until,
					now,
					diff: Math.ceil((new Date(ms.cooldown_until).getTime() - now) / 1000)
						+ 's',
				})
			}
		}
	})

	// ── Now Ticker (drives cooldown countdowns) ──
	$effect(() => {
		const tick = () => {
			now = serverNow()
		}
		tick()
		const interval = setInterval(tick, 1000)
		return () => clearInterval(interval)
	})

	// ── Season loading ─────────────────────────────────────
	async function loadSeasonScores(seasonId: string) {
		try {
			const res = await fetch(
				`/api/season/${encodeURIComponent(seasonId)}`,
			)
			const data = await res.json()
			seasonScores = data.scores ?? []
			// Populate member cache from season scores
			for (const s of seasonScores) {
				if (s.member_mid && s.member_kananame) {
					memberCache.set(s.member_mid, {
						kananame: s.member_kananame,
						nickname: s.member_nickname ?? '',
						classgroup: s.member_classgroup ?? '',
					})
				}
			}
		} catch (e) {
			console.error('Failed to load season scores:', e)
			seasonScores = []
		}
	}

	function handleSeasonChange() {
		if (!selectedSeasonId) return
		const s = seasons.find((s) => s.season_id === selectedSeasonId)
		if (s) {
			seasonInfo = { id: s.season_id, caption: s.caption }
			loadSeasonScores(s.season_id)
		}
	}

	function findAnimByName(elem: HTMLElement, name: string) {
		// get all the active animations on this element
		const anims = elem.getAnimations()
		// return the first one with the expected animationName
		console.log(anims)
		return anims.find((anim) => anim.id === name)
	}

	// ── Data Loading ───────────────────────────────────────
	let disconnectFn: (() => void) | null = null

	onMount(async () => {
		// Init theme from localStorage or system preference
		if (browser) {
			const saved = localStorage.getItem('kotaete-theme') as
				| 'dark'
				| 'light'
				| null
			if (saved) {
				theme = saved
			} else {
				theme = window.matchMedia('(prefers-color-scheme: light)').matches
					? 'light'
					: 'dark'
			}
			applyTheme(theme)

			const span1: HTMLSpanElement = document.querySelector('.wa-dot')!
			const span2: HTMLSpanElement = document.querySelector('.live-dot')!
			span1?.addEventListener('animationstart', (evt: AnimationEvent) => {
				if (evt.animationName === 'pulse') {
					const ani1 = findAnimByName(span1, 'pulse')
					const ani2 = findAnimByName(span2, 'pulse')
					if (ani1 && ani2) {
						ani1.startTime = ani2.startTime
					}
				}
			})
		}
		try {
			const [activeRes, seasonsRes] = await Promise.all([
				fetch(`/api/active?prefix=${encodeURIComponent(seasonPrefix)}`),
				fetch(`/api/seasons?prefix=${encodeURIComponent(seasonPrefix)}`),
			])
			const activeData = await activeRes.json()
			const seasonsData = await seasonsRes.json()

			// Compute clock offset from server Date header for accurate countdowns
			const serverDate = activeRes.headers.get('Date')
			if (serverDate) {
				clockOffset = new Date(serverDate).getTime() - Date.now()
			}

			session = activeData.session ?? null
			scores = activeData.scores ?? []
			// Hydrate member states from REST for immediate cooldown display
			if (activeData.memberStates?.length) {
				const msMap = new Map<string, LiveMemberStateType>()
				for (const ms of activeData.memberStates as LiveMemberStateType[]) {
					if (ms.member_mid) msMap.set(ms.member_mid, ms)
				}
				memberStates = msMap
			}
			// Build member cache from REST data (for enriching WS updates)
			for (const s of (activeData.scores ?? []) as LiveScore[]) {
				if (s.member_mid && s.member_kananame) {
					memberCache.set(s.member_mid, {
						kananame: s.member_kananame,
						nickname: s.member_nickname,
						classgroup: s.member_classgroup,
					})
				}
			}
			seasons = seasonsData

			if (seasonsData.length > 0) {
				const latest = seasonsData[0]
				seasonInfo = { id: latest.season_id, caption: latest.caption }
				selectedSeasonId = latest.season_id
				await loadSeasonScores(latest.season_id)
			}

			if (session) {
				const eventsRes = await fetch(
					`/api/events/${encodeURIComponent(session.id)}`,
				)
				const eventsData = await eventsRes.json()
				events = ((eventsData.events ?? []) as unknown[])
					.filter((evt): evt is Record<string, unknown> =>
						evt != null && typeof evt === 'object'
					)
					.map((evt) => normalizeIncomingEvent(evt))
					.slice(0, 20)
			}
		} catch (e) {
			console.error('Failed to load initial data:', e)
		}

		// ── Bot status polling ──
		async function checkBotStatus() {
			try {
				const res = await fetch('/api/bot-status')
				const data = await res.json()
				botOnline = data.daemon?.online ?? false
				connected = data.web?.online ?? false
			} catch {
				botOnline = false
				connected = false
			}
		}

		checkBotStatus()
		botStatusInterval = setInterval(checkBotStatus, 10_000)

		disconnectFn = connectLive({
			onEvent(table, action, record) {
				connected = true
				handleLiveEvent(table, action, record)
			},
			onViewers(count) {
				viewers = count
			},
			onOpen() {
				connected = true
				// Re-fetch active session on reconnect — session may have changed during disconnect
				refreshOnReconnect()
			},
			onClose() {
				connected = false
			},
		})
	})

	onDestroy(() => {
		disconnectFn?.()
		if (scoreRefreshTimer) clearTimeout(scoreRefreshTimer)
		if (botStatusInterval) clearInterval(botStatusInterval)
	})
</script>

<div class='dashboard'>
	<!-- ── Header ── -->
	<header class='header'>
		<div class='header-left'>
			<h1 class='title'>🏆 NIPBANG Kotaete</h1>
			{#if seasons.length > 0}
				<select
					class='badge-select'
					bind:value={selectedSeasonId}
					onchange={handleSeasonChange}
				>
					{#each seasons as s (s.season_id)}
						<option value={s.season_id}>
							{#if s.caption}
								{s.caption}
							{:else}
								{s.season_id}
							{/if}
						</option>
					{/each}
				</select>
			{:else if seasonInfo}
				<span class='badge'>{seasonInfo.caption ?? seasonInfo.id}</span>
			{/if}
		</div>
		<div class='header-right'>
			{#if connected && viewers > 0}
				<span class='viewer-count' title={`${viewers} online`}>🐱 {
						viewers
					}</span>
			{/if}
			<span class='live-dot' class:connected></span>
			<span
				class='status-text'
				title="Database {connected ? 'online' : 'offline'}"
			>DB</span>
			<span
				class='wa-dot'
				class:online={botOnline === true}
				class:offline={botOnline === false}
			></span>
			<span
				class='status-text'
				title="WhatsApp {botOnline ? 'online' : 'offline'}"
			>WA</span>
			<span class='separator'>·</span>
			<button class='theme-toggle' onclick={toggleTheme} title='Toggle theme'>
				{#if theme === 'dark'}
					<svg
						width='16'
						height='16'
						viewBox='0 0 24 24'
						fill='none'
						stroke='currentColor'
						stroke-width='2'
						stroke-linecap='round'
						stroke-linejoin='round'
					>
						<circle cx='12' cy='12' r='5' />
						<line x1='12' y1='1' x2='12' y2='3' />
						<line x1='12' y1='21' x2='12' y2='23' />
						<line x1='4.22' y1='4.22' x2='5.64' y2='5.64' />
						<line x1='18.36' y1='18.36' x2='19.78' y2='19.78' />
						<line x1='1' y1='12' x2='3' y2='12' />
						<line x1='21' y1='12' x2='23' y2='12' />
						<line x1='4.22' y1='19.78' x2='5.64' y2='18.36' />
						<line x1='18.36' y1='5.64' x2='19.78' y2='4.22' />
					</svg>
				{:else}
					<svg
						width='16'
						height='16'
						viewBox='0 0 24 24'
						fill='none'
						stroke='currentColor'
						stroke-width='2'
						stroke-linecap='round'
						stroke-linejoin='round'
					>
						<path d='M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' />
					</svg>
				{/if}
			</button>
		</div>
	</header>

	<!-- ── Content Grid ── -->
	<div class='content-grid'>
		<div class='column-left'>
			<!-- ── Main Card ── -->
			<div class='main-card'>
				{#if displayMode === 'intro'}
					<div class='intro-card'>
						<div class='intro-emoji'>🎯</div>
						<div class='intro-label'>Quiz starting soon</div>
						{#if introCountdownText}
							<div class='intro-countdown'>{introCountdownText}</div>
						{:else}
							<div class='intro-countdown'>...</div>
						{/if}
					</div>
				{:else if displayMode === 'question'}
					<div class='question-card'>
						<div class='question-header'>
							<span class='question-label'>Q{session?.current_question}</span>
							<span
								class='timer'
								class:timer-warning={timeRemaining < 600 && timeRemaining >= 30}
								class:timer-caution={timeRemaining < 30 && timeRemaining > 0}
							>
								{countdownText}
							</span>
						</div>
						{#if questionImageUrl && !imageError}
							<img
								src={questionImageUrl}
								alt='Question {session?.current_question}'
								class='question-image'
								onerror={() => (imageError = true)}
							/>
						{:else if imageError}
							<div class='image-placeholder'>🖼️ Image unavailable</div>
						{/if}
					</div>
				{:else if displayMode === 'winner'}
					<div class='result-card winner-card'>
						<div class='result-emoji'>🎉</div>
						<div class='result-name'>{winnerInfo?.displayName}</div>
						<div class='result-points'>+{winnerInfo?.points}pts</div>
						{#if winnerInfo?.answer}
							<div class='result-answer'>{winnerInfo.answer}</div>
						{/if}
					</div>
				{:else if displayMode === 'timeout'}
					<div class='result-card timeout-card'>
						<div class='result-emoji'>⏰</div>
						<div class='result-title'>Time's up!</div>
						{#if timeoutInfo?.answers}
							<div class='timeout-answers'>
								{#each Object.entries(timeoutInfo.answers) as [type, answer] (type)}
									<span class='answer-tag'>{answer}</span>
								{/each}
							</div>
						{/if}
					</div>
				{:else if displayMode === 'finished'}
					<div class='result-card finished-card'>
						<div class='result-emoji'>🏁</div>
						<div class='result-title'>Quiz Finished!</div>
						{#if sortedScores.length > 0}
							<p class='finished-subtitle'>
								🏆 {sortedScores[0].points}pts — {
									memberDisplay(
										sortedScores[0].member_kananame,
										sortedScores[0].member_classgroup,
									)
								}
							</p>
						{/if}
					</div>
				{:else}
					<div class='result-card idle-card'>
						{#if session}
							<div class='result-emoji'>⏳</div>
							<p>Waiting for next question...</p>
						{:else if seasonInfo}
							<div class='result-emoji'>🏆</div>
							<p class='result-title'>{seasonInfo.caption ?? 'Season'}</p>
							<p class='finished-subtitle'>
								No active quiz right now — check the season standings!
							</p>
						{:else}
							<div class='result-emoji'>🎬</div>
							<p>No active quiz</p>
						{/if}
					</div>
				{/if}
			</div>

			<!-- ── Live Scores ── -->
			<div class='card'>
				<h2 class='card-title'>📊 Live Scores</h2>
				{#if sortedScores.length > 0}
					<div class='scores-list'>
						{#each sortedScores.slice(0, 10) as score, i (score.id)}
							{@const ms = memberStates.get(score.member_mid)}
							{@const cooldownSec = ms?.cooldown_until
							? Math.max(0, Math.ceil((new Date(ms.cooldown_until).getTime() - now) / 1000))
							: 0}
							{@const cooldownText = cooldownSec > 0
							? `${Math.floor(cooldownSec / 60)}:${
								(cooldownSec % 60).toString().padStart(2, '0')
							}`
							: ''}
							<div class='score-row'>
								<span class='rank'>{i + 1}</span>
								<span
									class='member-name'
									title={score.member_nickname ?? undefined}
								>
									{
										memberDisplay(score.member_kananame, score.member_classgroup)
									}
								</span>
								{#if cooldownSec > 0 && displayMode !== 'finished'}
									<span
										class='cooldown-badge'
										class:dimmed={isGodStage}
										title={isGodStage ? 'Cooldown (not active during GOD stage)' : 'Cooldown'}
									>⏳ {cooldownText}</span>
								{/if}
								<span class='points'>{score.points} 🌸</span>
							</div>
						{/each}
					</div>
				{:else}
					<div class='empty-state'>Waiting for answers...</div>
				{/if}
			</div>
		</div>

		<div class='column-right'>
			<!-- ── Event History ── -->
			<div class='card'>
				<h2 class='card-title'>📜 Event History</h2>
				<div class='events-list'>
					{#if events.length === 0}
						<div class='empty-state'>No events yet</div>
					{:else}
						{#each events as event (event.id)}
							{@const formatted = formatEvent(event)}
							{@const time = formatHm(event.created_at)}
							<div class='event-row' style='color: {formatted.color}'>
								<span class='event-time'>{time}</span>
								{formatted.text}
							</div>
						{/each}
					{/if}
				</div>
			</div>

			<!-- ── Season Scoreboard ── -->
			{#if topSeasonScores.length > 0}
				<div class='card'>
					<div class='card-header'>
						<h2 class='card-title'>🏅 Season Scoreboard</h2>
						<div class='header-right-group'>
							{#if seasonInfo?.caption}
								<span class='badge small'>{seasonInfo.caption}</span>
							{/if}
							<button
								class='toggle-btn'
								onclick={() => (showZeroPts = !showZeroPts)}
							>
								{showZeroPts ? 'Hide' : 'Show'} 0 🌸
							</button>
						</div>
					</div>
					<div class='scores-list'>
						{#each topSeasonScores as score, i (score.id)}
							<div class='score-row'>
								<span class='rank'>{i + 1}</span>
								<span
									class='member-name'
									title={score.member_nickname ?? undefined}
								>{
									memberDisplay(score.member_kananame, score.member_classgroup)
								}</span>
								<span class='points'>{score.points} 🌸</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	</div>
	<footer class='footer'>© 2026 NIPBANG</footer>
</div>

<style>
	:global(:root) {
		--bg-primary: #0f0f1a;
		--bg-card: #1a1a2e;
		--bg-card-hover: #252540;
		--text-primary: #e2e8f0;
		--text-secondary: #94a3b8;
		--accent-green: #4ade80;
		--accent-orange: #fb923c;
		--accent-red: #ef4444;
		--accent-blue: #60a5fa;
		--accent-yellow: #fbbf24;
		--accent-purple: #a78bfa;
	}
	:global(body) {
		background-color: var(--bg-primary);
		margin: 0;
	}

	:global(:root.light) {
		--bg-primary: #f1f5f9;
		--bg-card: #ffffff;
		--bg-card-hover: #f8fafc;
		--text-primary: #1e293b;
		--text-secondary: #64748b;
		--accent-green: #22c55e;
		--accent-orange: #ea580c;
		--accent-red: #dc2626;
		--accent-blue: #2563eb;
		--accent-yellow: #d97706;
		--accent-purple: #7c3aed;
	}

	.dashboard {
		max-width: 480px;
		margin: 0 auto;
		padding: 1rem;
		font-family: system-ui, 'Hiragino Sans', 'Noto Sans JP', sans-serif;
		color: var(--text-primary);
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	/* ── Content Grid (mobile: single column, desktop: two columns) ── */

	.content-grid {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.column-left,
	.column-right {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	@media (min-width: 768px) {
		.dashboard {
			max-width: 960px;
		}

		.content-grid {
			flex-direction: row;
			align-items: flex-start;
		}

		.column-left {
			flex: 1.3;
			position: sticky;
			top: 1rem;
		}

		.column-right {
			flex: 1;
			position: sticky;
			top: 1rem;
			max-height: calc(100vh - 2rem);
			overflow-y: auto;
		}

		.events-list {
			max-height: none;
			flex: 1;
		}
		}

	/* ── Header ── */

	.header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.5rem 0;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.title {
		font-size: 1.25rem;
		margin: 0;
		font-weight: 700;
	}

	.badge {
		background: var(--accent-purple);
		color: white;
		padding: 0.15rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.badge.small {
		font-size: 0.65rem;
	}

	.badge-select {
		appearance: none;
		-webkit-appearance: none;
		background: var(--accent-purple);
		color: white;
		border: none;
		padding: 0.15rem 1.4rem 0.15rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		font-weight: 600;
		font-family: inherit;
		cursor: pointer;
		white-space: nowrap;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='white'%3E%3Cpath d='M0 0l5 6 5-6z'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 0.4rem center;
	}

	.badge-select:hover {
		opacity: 0.9;
	}

	.badge-select:focus {
		outline: 2px solid var(--accent-blue);
		outline-offset: 1px;
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.live-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-secondary);
		display: inline-block;
		flex-shrink: 0;
	}

	.live-dot.connected {
		background: var(--accent-green);
		animation: pulse 5s ease-in-out infinite;
	}

	.separator {
		color: var(--text-secondary);
		font-size: 0.75rem;
		opacity: 0.4;
	}

	.wa-dot {
		width: 8px;
		height: 8px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-secondary);
		display: inline-block;
		flex-shrink: 0;
	}

	.wa-dot.online {
		background: var(--accent-green);
		animation: pulse 5s ease-in-out infinite;
	}

	.wa-dot.offline {
		background: var(--accent-red, #ef4444);
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}

	.status-text {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.viewer-count {
		font-size: 0.7rem;
		font-weight: bold;
		color: var(--text-secondary);
		background: var(--surface-2);
		padding: 0.15rem 0.45rem;
		border-radius: 9999px;
		margin-left: 0.4rem;
	}

	.theme-toggle {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 0.25rem;
		display: flex;
		align-items: center;
		margin-left: 0.3rem;
		border-radius: 4px;
	}

	.theme-toggle:hover {
		color: var(--text-primary);
		background: var(--bg-card-hover);
	}

	/* ── Cards ── */

	.card,
	.main-card {
		background: var(--bg-card);
		border-radius: 12px;
		padding: 1rem;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
	}

	.main-card {
		min-height: 200px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.card-title {
		font-size: 0.9rem;
		margin: 0 0 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.75rem;
	}

	.card-header .card-title {
		margin: 0;
	}

	/* ── Question Card ── */

	.question-card {
		width: 100%;
	}

	.question-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.75rem;
	}

	.question-label {
		font-size: 1rem;
		font-weight: 700;
		color: var(--accent-blue);
	}

	.timer {
		font-size: 1.1rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--accent-green);
	}

	.timer-warning {
		color: var(--accent-orange);
	}

	.timer-caution {
		color: var(--accent-red);
		animation: pulse 1s ease-in-out infinite;
	}

	.question-image {
		width: 100%;
		border-radius: 8px;
		display: block;
	}

	.image-placeholder {
		width: 100%;
		aspect-ratio: 16 / 10;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-card-hover);
		border-radius: 8px;
		color: var(--text-secondary);
		font-size: 1.25rem;
	}

	/* ── Intro Card ── */

	.intro-card {
		text-align: center;
		padding: 2rem 1rem;
		width: 100%;
	}

	.intro-emoji {
		font-size: 3rem;
		margin-bottom: 0.5rem;
	}

	.intro-label {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-secondary);
		margin-bottom: 0.75rem;
	}

	.intro-countdown {
		font-size: 4rem;
		font-weight: 800;
		color: var(--accent-blue);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.05em;
	}

	/* ── Result Cards (Winner / Timeout / Idle) ── */

	.result-card {
		text-align: center;
		padding: 1rem 0;
		width: 100%;
	}

	.result-emoji {
		font-size: 3rem;
		margin-bottom: 0.5rem;
	}

	.result-name {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--accent-green);
		margin-bottom: 0.25rem;
	}

	.result-points {
		font-size: 2rem;
		font-weight: 800;
		color: var(--accent-green);
	}

	.result-answer {
		margin-top: 0.5rem;
		font-size: 1.1rem;
		color: var(--text-secondary);
	}

	.result-title {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--accent-red);
	}

	.timeout-answers {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		justify-content: center;
		margin-top: 0.75rem;
	}

	.answer-tag {
		background: var(--bg-card-hover);
		padding: 0.25rem 0.75rem;
		border-radius: 6px;
		font-size: 0.9rem;
		color: var(--text-primary);
	}

	.idle-card p {
		color: var(--text-secondary);
		margin: 0.25rem 0 0;
		font-size: 0.9rem;
	}

	.finished-card .result-title {
		color: var(--accent-green);
	}

	.finished-subtitle {
		color: var(--text-secondary);
		font-size: 0.85rem;
		margin: 0.25rem 0 0;
	}

	/* ── Scores ── */

	.scores-list {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.score-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
	}

	.rank {
		width: 1.5rem;
		text-align: center;
		color: var(--text-secondary);
		font-weight: 600;
		flex-shrink: 0;
	}

	.member-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.points {
		font-weight: 700;
		color: var(--accent-green);
		flex-shrink: 0;
	}

	.cooldown-badge {
		font-size: 0.7rem;
		padding: 2px 6px;
		border-radius: 9999px;
		background: var(--accent-orange);
		color: #fff;
		font-weight: 600;
		flex-shrink: 0;
	}

	.cooldown-badge.dimmed {
		opacity: 0.4;
		text-decoration: line-through;
	}

	/* ── Events ── */

	.events-list {
		max-height: 300px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.events-list::-webkit-scrollbar {
		width: 4px;
	}

	.events-list::-webkit-scrollbar-thumb {
		background: var(--bg-card-hover);
		border-radius: 2px;
	}

	.event-row {
		font-size: 0.8rem;
		padding: 0.3rem 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
		display: flex;
		gap: 0.5rem;
	}


	.event-time {
		color: var(--text-muted);
		opacity: 0.55;
		font-size: 0.68rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
		min-width: 2.5rem;
	}
	.empty-state {
		text-align: center;
		padding: 1rem;
		color: var(--text-secondary);
		font-style: italic;
	}

	/* ── Toggle Button ── */

	.header-right-group {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.toggle-btn {
		background: var(--bg-card-hover);
		color: var(--text-secondary);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 6px;
		padding: 0.2rem 0.5rem;
		font-size: 0.65rem;
		cursor: pointer;
		white-space: nowrap;
	}

	.toggle-btn:hover {
		color: var(--text-primary);
		border-color: rgba(255, 255, 255, 0.2);
	}

	.footer {
		text-align: center;
		padding: 12px 0;
		color: var(--text-muted);
		font-size: 0.75rem;
	}
</style>
