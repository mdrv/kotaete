import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { SPECIAL_STAGE_NUMBER } from '../constants.ts'
import type { QuizBundle, QuizQuestion } from '../types.ts'

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const SECTION_SEP = '---'

function parseQuestionMarkdown(
	markdown: string,
): { text: string; answers: string[]; explanation: string } {
	const sections = markdown.split(SECTION_SEP)

	const text = sections[0]?.trim() ?? ''
	if (text.length === 0) {
		throw new Error('question text (first section before ---) is empty')
	}

	const answerLines = sections[1]
		?.trim()
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map((l) => l.trim()) ?? []

	if (answerLines.length === 0) {
		throw new Error(
			'answers section (second section after first ---) is empty or missing',
		)
	}

	const explanation = sections[2]?.trim() ?? ''

	return { text, answers: answerLines, explanation }
}

function extractQuestionNumber(filename: string): number | null {
	const name = basename(filename, '.md')

	// Try trailing -<number>.md  e.g. "something-5.md"
	const trailing = name.match(/-(\d+)$/)
	if (trailing) return Number(trailing[1])

	// Try plain <number>.md  e.g. "5.md"
	const plain = name.match(/^(\d+)$/)
	if (plain) return Number(plain[1])

	return null
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

async function resolveImagePath(
	dir: string,
	markdownFilename: string,
): Promise<string | null> {
	const stem = basename(markdownFilename, '.md')

	for (const ext of IMAGE_EXTS) {
		const candidate = resolve(dir, `${stem}${ext}`)
		try {
			const s = await stat(candidate)
			if (s.isFile()) return candidate
		} catch {
			// not found – try next
		}
	}

	return null
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function parseIntroTime(dirBasename: string): Date {
	const m = dirBasename.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/)
	if (!m) {
		throw new Error(
			`[quiz] directory name "${dirBasename}" does not match YYYYMMDD-HHMM format`,
		)
	}

	// Asia/Jakarta = UTC+7
	const year = Number(m[1])
	const month = Number(m[2]) - 1
	const day = Number(m[3])
	const hour = Number(m[4])
	const minute = Number(m[5])

	// Build a UTC date that represents Asia/Jakarta local time.
	// To avoid DST issues we compute the timestamp manually.
	const utcMs = Date.UTC(year, month, day, hour - 7, minute, 0, 0)
	return new Date(utcMs)
}

// ---------------------------------------------------------------------------
// Intro-note autodetect
// ---------------------------------------------------------------------------

async function detectIntroNote(
	dir: string,
	dirBasename: string,
): Promise<string | null> {
	const directIntro = resolve(dir, 'intro.md')
	try {
		const s = await stat(directIntro)
		if (s.isFile()) return await readFile(directIntro, 'utf-8')
	} catch {
		// no direct intro.md, continue with legacy candidates
	}

	const datePrefix = dirBasename.slice(0, 8) // YYYYMMDD

	const candidates = [
		`${dirBasename}-0-start.md`,
		`${datePrefix}-0-start.md`,
		'0-start.md',
		'start.md',
	]

	for (const name of candidates) {
		const abs = resolve(dir, name)
		try {
			const s = await stat(abs)
			if (s.isFile()) {
				return await readFile(abs, 'utf-8')
			}
		} catch {
			// not found – try next
		}
	}

	return null
}

async function detectOutroNote(dir: string): Promise<string | null> {
	const path = resolve(dir, 'outro.md')
	try {
		const s = await stat(path)
		if (!s.isFile()) return null
		return await readFile(path, 'utf-8')
	} catch {
		return null
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a full `QuizBundle` from a directory on disk.
 *
 * @param quizDir - Absolute or relative path to the quiz directory.
 *   The **basename** must be `YYYYMMDD-HHMM` (Asia/Jakarta intro time).
 */
export async function loadQuizBundle(
	quizDir: string,
): Promise<QuizBundle> {
	const absDir = resolve(quizDir)
	const dirBasename = basename(absDir)

	// Parse intro time from directory name
	const introAt = parseIntroTime(dirBasename)
	const startAt = new Date(introAt.getTime() + 10 * 60 * 1000)

	// Intro note (optional)
	const introNote = await detectIntroNote(absDir, dirBasename)
	const outroNote = await detectOutroNote(absDir)

	// Collect .md files
	const allFiles = await readdir(absDir)
	const mdFiles = allFiles.filter((f) => f.endsWith('.md'))

	// Build set of intro candidate filenames for exclusion
	const datePrefix = dirBasename.slice(0, 8)
	const introCandidateNames = new Set([
		`${dirBasename}-0-start.md`,
		`${datePrefix}-0-start.md`,
		'0-start.md',
		'start.md',
	])

	const questionFiles = mdFiles.filter(
		(f) => !introCandidateNames.has(f),
	)

	const questions: QuizQuestion[] = []

	for (const mdFile of questionFiles) {
		const number = extractQuestionNumber(mdFile)
		if (number === null) {
			// Skip files that don't carry a question number
			continue
		}

		const raw = await readFile(resolve(absDir, mdFile), 'utf-8')
		const { text, answers, explanation } = parseQuestionMarkdown(raw)

		const imagePath = await resolveImagePath(absDir, mdFile)
		const isSpecialStage = number === SPECIAL_STAGE_NUMBER

		questions.push({
			number,
			text,
			answers,
			explanation,
			imagePath,
			isSpecialStage,
		})
	}

	// Sort by question number ascending
	questions.sort((a, b) => a.number - b.number)

	return {
		directory: absDir,
		introAt,
		startAt,
		introNote,
		outroNote,
		questions,
	}
}
