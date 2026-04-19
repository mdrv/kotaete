import type { NMember, QuizMessageTemplates, QuizQuestion } from '../types.ts'

type QuestionProgress = {
	index: number
	total: number
}

type RoundLine = {
	emoji: string
	time: string
	count: number
}

const JAPANESE_WEEKDAY_KANJI: ReadonlyArray<string> = ['日', '月', '火', '水', '木', '金', '土']

const DEFAULT_TEMPLATES: QuizMessageTemplates = {
	introHeader: '🚀 *はやくこたえて！ START*',
	introRoundLine: '- {emoji} {time} (x{count})',
	godStageAnnouncement: [
		'🚨 *INCOMING!* 🚨',
		'🪽 *神のステージ (Kami no Stage)*',
		'',
		'Khusus stage ini, ketentuannya:',
		'🌸 Jawaban benar = {points} poin!',
		'🥳 Siapa pun bisa jawab! (no cooldown)',
		'🙈 Cuma 1x kesempatan per anggota',
		'⏰ Timeout soal {timeoutMinutes} menit',
		'',
		'🐻 Soal akan muncul dalam {delayMinutes} menit!',
	].join('\n'),
	nextRoundNotice: 'Ronde berikutnya mulai pukul {time} WIB. Bersiaplah!',
	questionFooter: '⏰ *{time} WIB*',
	cooldownWarning: 'Baru bisa jawab lagi mulai {time} WIB!',
	questionCooldown: '*Cooldown:*\n{entries}',
	questionWarning: '⏰ Tinggal 10 menit lagi!',
	timeout: '⏱️ Waktu habis untuk soal ini.\n✅ {answers}',
	winner: '🤗 *せいかいだった！*\n🌸 *{name}({classgroup})* _+{points}pts_\n✅ {answers}',
	winnerPerfect: '🤩 *かんぺきだった！*\n🌸 *{name}({classgroup})* _+{points}pts_\n✅ {answers}',
	romajiTease: 'Kayaknya ada yang kelupaan...',
	explanation: '🌻 *_Shitteimasu ka?_* *({progress})*\n{text}',
	explanationSpecial: '🌻 *_Shitteimasu ka?_* *(神)*\n{text}',
	breakHeader: '☕ *はやくこたえて！ BREAK*',
	finalHeader: '🏁 *はやくこたえて！ END*',
	finalRow: '- *{name}({classgroup})* 🌸 *+{points} pts*',
	finalEmpty: '(_tidak ada yang meraih poin_)',
	finalFooterDefault: '🐻 * _gao gao, gao!_ *',
}

function resolveTemplates(overrides?: Partial<QuizMessageTemplates>): QuizMessageTemplates {
	return {
		...DEFAULT_TEMPLATES,
		...(overrides ?? {}),
	}
}

function applyTemplate(template: string, values: Record<string, string | number>): string {
	let out = template
	for (const [key, value] of Object.entries(values)) {
		out = out.replaceAll(`{${key}}`, String(value))
	}
	return out
}

function formatDayId(date: Date): string {
	const dayText = new Intl.DateTimeFormat('id-ID', {
		timeZone: 'Asia/Jakarta',
		day: 'numeric',
		month: 'long',
		year: 'numeric',
	}).format(date)
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'Asia/Jakarta',
		weekday: 'short',
	}).formatToParts(date)
	const weekdayPart = parts.find((part) => part.type === 'weekday')?.value
	const weekdayMap: Record<string, number> = {
		Sun: 0,
		Mon: 1,
		Tue: 2,
		Wed: 3,
		Thu: 4,
		Fri: 5,
		Sat: 6,
	}
	const weekdayIndex = weekdayPart ? weekdayMap[weekdayPart] : undefined
	const weekdayKanji = weekdayIndex === undefined ? '？' : (JAPANESE_WEEKDAY_KANJI[weekdayIndex] ?? '？')
	return `${weekdayKanji}︱${dayText}`
}

export function formatIntro(
	introAt: Date,
	note: string | null,
	opts?: { templates?: Partial<QuizMessageTemplates>; rounds?: ReadonlyArray<RoundLine> },
): string {
	const templates = resolveTemplates(opts?.templates)
	const lines = [
		templates.introHeader,
		`🗓️ *${formatDayId(introAt)}*`,
	]
	if (opts?.rounds?.length) {
		lines.push('', ...opts.rounds.map((round) => applyTemplate(templates.introRoundLine, round)))
	}
	if (note?.trim()) lines.push('', note.trim())
	return lines.join('\n')
}

export function formatQuestion(
	question: QuizQuestion,
	progress: QuestionProgress | null,
	timeHint: string,
	templates?: Partial<QuizMessageTemplates>,
	cooldownEntries?: ReadonlyArray<{ name: string; classgroup: string; time: string }> | null,
): string {
	const t = resolveTemplates(templates)
	const header = progress
		? `🌟 *はやくこたえて！ (${progress.index}/${progress.total})*`
		: '🌈 *はやくこたえて！ (神)*'
	let result = `${header}\n\n${question.text}`
	if (cooldownEntries && cooldownEntries.length > 0) {
		const entries = cooldownEntries
			.toSorted((a, b) => a.time.localeCompare(b.time))
			.map((e) => `${e.name} (${e.classgroup}) - ${e.time}`)
			.join('\n')
		result += `\n\n${applyTemplate(t.questionCooldown, { entries })}`
	}
	result += `\n\n${applyTemplate(t.questionFooter, { time: timeHint })}`
	return result
}

export function formatOutroHeader(outroAt: Date): string {
	return `🗓️ *${formatDayId(outroAt)}*`
}

function formatAnswerList(
	answers: ReadonlyArray<string>,
	answerExtraPts?: ReadonlyMap<string, number> | undefined,
): string {
	return answers
		.map((a) => (answerExtraPts?.get(a) ? `_*${a}*_` : `_${a}_`))
		.join(' / ')
}
export function formatWinner(
	member: NMember,
	answers: ReadonlyArray<string>,
	points: number,
	answerExtraPts?: ReadonlyMap<string, number> | undefined,
	templates?: Partial<QuizMessageTemplates>,
): string {
	const t = resolveTemplates(templates)
	return applyTemplate(t.winner, {
		name: member.kananame,
		classgroup: member.classgroup,
		points,
		answers: formatAnswerList(answers, answerExtraPts),
	})
}

export function formatWinnerPerfect(
	member: NMember,
	answers: ReadonlyArray<string>,
	points: number,
	answerExtraPts?: ReadonlyMap<string, number> | undefined,
	templates?: Partial<QuizMessageTemplates>,
): string {
	const t = resolveTemplates(templates)
	return applyTemplate(t.winnerPerfect, {
		name: member.kananame,
		classgroup: member.classgroup,
		points,
		answers: formatAnswerList(answers, answerExtraPts),
	})
}

export function formatRomajiTease(
	answer: string,
	templates?: Partial<QuizMessageTemplates>,
): string {
	const t = resolveTemplates(templates)
	return applyTemplate(t.romajiTease, { answer })
}

export function formatExplanation(
	question: QuizQuestion,
	progress: QuestionProgress | null,
	templates?: Partial<QuizMessageTemplates>,
): string | null {
	if (!question.explanation.trim()) return null
	const t = resolveTemplates(templates)
	if (!progress) {
		return applyTemplate(t.explanationSpecial, { text: question.explanation.trim() })
	}
	return applyTemplate(t.explanation, {
		progress: `${progress.index}/${progress.total}`,
		text: question.explanation.trim(),
	})
}

export function formatFinalScoreboard(
	sorted: Array<{ member: NMember; points: number }>,
	outroNote: string | null,
	outroAt: Date,
	templates?: Partial<QuizMessageTemplates>,
	opts?: { breakMode?: boolean; preface?: string | null; postface?: string | null },
): string {
	const t = resolveTemplates(templates)
	const body = sorted.length
		? sorted.map((entry) =>
			applyTemplate(t.finalRow, {
				name: entry.member.kananame,
				classgroup: entry.member.classgroup,
				points: entry.points,
			})
		).join('\n')
		: t.finalEmpty
	const header = formatOutroHeader(outroAt)
	const footer = outroNote?.trim() || t.finalFooterDefault
	const title = opts?.breakMode ? t.breakHeader : t.finalHeader
	const preface = opts?.preface?.trim()
	const postface = opts?.postface?.trim()
	const core = `${title}\n${header}\n\n${body}\n\n${footer}`
	const withPreface = preface ? `${preface}\n\n${core}` : core
	return postface ? `${withPreface}\n${postface}` : withPreface
}

export function formatQuestionWarning(templates?: Partial<QuizMessageTemplates>): string {
	return resolveTemplates(templates).questionWarning
}

export function formatCooldownWarning(time: string, templates?: Partial<QuizMessageTemplates>): string {
	return applyTemplate(resolveTemplates(templates).cooldownWarning, { time })
}

export function formatTimeout(answers: ReadonlyArray<string>, templates?: Partial<QuizMessageTemplates>): string {
	return applyTemplate(resolveTemplates(templates).timeout, { answers: answers.map((a) => `_${a}_`).join(' / ') })
}

export function formatNextRoundNotice(time: string, templates?: Partial<QuizMessageTemplates>): string {
	return applyTemplate(resolveTemplates(templates).nextRoundNotice, { time })
}

export function formatGodStageAnnouncement(
	templates?: Partial<QuizMessageTemplates>,
	opts?: { points?: number; timeoutMinutes?: number; delayMinutes?: number },
): string {
	const t = resolveTemplates(templates)
	return applyTemplate(t.godStageAnnouncement, {
		points: opts?.points ?? 25,
		timeoutMinutes: opts?.timeoutMinutes ?? 30,
		delayMinutes: opts?.delayMinutes ?? 1,
	})
}

// ---------------------------------------------------------------------------
// Season scoreboard messages
// ---------------------------------------------------------------------------

export function formatSeasonTopMessage(
	sorted: ReadonlyArray<{ member: NMember; points: number }>,
	caption?: string,
): string {
	const medalEmojis = ['🥇', '🥈', '🥉']
	const lines = ['🏆 *Hasil NIPBANG Kotaete!*']
	if (caption?.trim()) lines.push(`_${caption.trim()}_`)
	lines.push('')
	const top3 = sorted.slice(0, 3)
	for (let i = 0; i < top3.length; i++) {
		const entry = top3[i]!
		const medal = medalEmojis[i] ?? ''
		lines.push(`${medal} *${entry.member.kananame}/${entry.member.nickname} (${entry.member.classgroup})*`)
	}
	lines.push('')
	lines.push('🎊 *みんな、おめでとう！* 🎊')
	return lines.join('\n')
}

export function formatSeasonOthersMessage(
	sorted: ReadonlyArray<{ member: NMember; points: number }>,
): string | null {
	const others = sorted.slice(3)
	if (others.length === 0) return null
	const lines = ['🐻 _* gao gao gao! *_', 'Selamat juga kepada partisipan lainnya!', '']
	for (const entry of others) {
		lines.push(
			`🌸 *${entry.member.kananame}/${entry.member.nickname} (${entry.member.classgroup})* +${entry.points} pts`,
		)
	}
	return lines.join('\n')
}
