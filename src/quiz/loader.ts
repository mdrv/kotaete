import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { SPECIAL_STAGE_NUMBER } from '../constants.ts'
import type { QuizBundle, QuizQuestion, QuizScheduleConfig } from '../types.ts'

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
// Schedule config helpers
// ---------------------------------------------------------------------------

function isValidDate(value: unknown): value is Date {
	return value instanceof Date && !Number.isNaN(value.getTime())
}

function normalizeDateValue(value: unknown, key: 'intro' | 'start'): Date {
	if (isValidDate(value)) return value
	if (typeof value === 'string' || typeof value === 'number') {
		const parsed = new Date(value)
		if (isValidDate(parsed)) return parsed
	}
	throw new Error(`[quiz] invalid ${key} in kotaete.ts: expected a valid Date value`)
}

export function defineConfig(
	config: { intro: Date | string | number; start: Date | string | number },
): QuizScheduleConfig {
	return {
		intro: normalizeDateValue(config.intro, 'intro'),
		start: normalizeDateValue(config.start, 'start'),
	}
}

async function readScheduleConfig(absDir: string): Promise<QuizScheduleConfig | null> {
	const configPath = resolve(absDir, 'kotaete.ts')
	try {
		const cfgStat = await stat(configPath)
		if (!cfgStat.isFile()) return null
	} catch {
		return null
	}

	const source = await readFile(configPath, 'utf-8')
	const stripped = source.replace(
		/^\s*import\s*\{\s*defineConfig\s*\}\s*from\s*['"]@mdrv\/kotaete['"]\s*;?\s*$/gm,
		'',
	)
	if (stripped === source) {
		throw new Error('[quiz] kotaete.ts must import defineConfig from "@mdrv/kotaete"')
	}
	const tsModule = `const defineConfig = (config) => config\n${stripped}`
	let jsModule = tsModule
	try {
		jsModule = new Bun.Transpiler({ loader: 'ts' }).transformSync(tsModule)
	} catch (error) {
		throw new Error(`[quiz] failed to transpile kotaete.ts: ${error instanceof Error ? error.message : String(error)}`)
	}
	const specifier = `data:text/javascript;base64,${Buffer.from(jsModule, 'utf-8').toString('base64')}`
	const mod = await import(specifier) as { default?: unknown }
	if (!mod.default || typeof mod.default !== 'object') {
		throw new Error('[quiz] kotaete.ts must default-export config via defineConfig({...})')
	}

	const raw = mod.default as { intro?: unknown; start?: unknown }
	if (raw.intro === undefined || raw.start === undefined) {
		throw new Error('[quiz] kotaete.ts config must contain both "intro" and "start" fields')
	}

	return {
		intro: normalizeDateValue(raw.intro, 'intro'),
		start: normalizeDateValue(raw.start, 'start'),
	}
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
	opts?: { noSchedule?: boolean },
): Promise<QuizBundle> {
	const absDir = resolve(quizDir)
	const dirBasename = basename(absDir)

	let introAt: Date
	let startAt: Date
	if (opts?.noSchedule) {
		const now = new Date()
		introAt = now
		startAt = now
	} else {
		const schedule = await readScheduleConfig(absDir)
		if (!schedule) {
			throw new Error(`[quiz] missing kotaete.ts schedule config in "${absDir}"`)
		}
		introAt = schedule.intro
		startAt = schedule.start
	}

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
