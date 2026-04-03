import type { NMember, QuizQuestion } from '../types.ts'

type QuestionProgress = {
	index: number
	total: number
}

const JAPANESE_WEEKDAY_KANJI: ReadonlyArray<string> = ['日', '月', '火', '水', '木', '金', '土']

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

export function formatIntro(introAt: Date, note: string | null): string {
	const lines = [
		'🚀 *はやくこたえて！ START*',
		`🗓️ *${formatDayId(introAt)}*`,
	]
	if (note?.trim()) lines.push('', note.trim())
	return lines.join('\n')
}

export function formatQuestion(
	question: QuizQuestion,
	progress: QuestionProgress | null,
	timeHint: string,
): string {
	const header = progress
		? `🌟 *はやくこたえて！ (${progress.index}/${progress.total})*`
		: '🌟 *はやくこたえて！ (神)*'
	return `${header}\n\n${question.text}\n\n⏰ ${timeHint} WIB`
}

export function formatOutroHeader(outroAt: Date): string {
	return `🗓️ *${formatDayId(outroAt)}*`
}

export function formatWinner(member: NMember, answers: ReadonlyArray<string>): string {
	return `🤗 *せいかいだった！*\n🌸 *${member.kananame}(${member.classgroup})*\n✅ ${
		answers.map((a) => `_${a}_`).join(' / ')
	}`
}

export function formatWinnerKanjiPerfect(member: NMember, answers: ReadonlyArray<string>): string {
	return `🤩 *かんぺきだった！*\n🌸 *${member.kananame}(${member.classgroup})*\n✅ ${
		answers.map((a) => `_${a}_`).join(' / ')
	}`
}

export function formatExplanation(
	question: QuizQuestion,
	progress: QuestionProgress | null,
): string | null {
	if (!question.explanation.trim()) return null
	if (!progress) {
		return `🌻 *_Shitteimasu ka?_* *(神)*\n${question.explanation.trim()}`
	}
	return `🌻 *_Shitteimasu ka?_* *(${progress.index}/${progress.total})*\n${question.explanation.trim()}`
}

export function formatFinalScoreboard(
	sorted: Array<{ member: NMember; points: number }>,
	outroNote: string | null,
	outroAt: Date,
): string {
	const body = sorted.length
		? sorted.map((entry) => `- *${entry.member.kananame}(${entry.member.classgroup})* 🌸 *+${entry.points} pts*`).join(
			'\n',
		)
		: '(_tidak ada yang meraih poin_)'
	const header = formatOutroHeader(outroAt)
	const footer = outroNote?.trim()
		|| '🐻 * _gao gao, gao!_ *\nHasil perolehan poin akan diumumkan besok pagi. Sampai jumpa besok!'
	return `🏁 *はやくこたえて！ END*\n${header}\n\n${body}\n\n${footer}`
}
