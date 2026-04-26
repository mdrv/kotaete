import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { QUIZ_TUNABLES } from '../constants.ts'
import type {
	ConfigAnswerEntry,
	ConfigQuestion,
	ConfigQuestionAnswers,
	ConfigQuestionImage,
	NMember,
	QuizBundle,
	QuizMessageTemplates,
	QuizQuestion,
	QuizRound,
	QuizScheduleConfig,
	QuizScheduleConfigInput,
	QuizTunables,
	QuizTunablesInput,
	SeasonConfig,
} from '../types.ts'

const SECTION_SEP = '---'
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'] as const
const CONFIG_IMPORT_RE = /^\s*import\s*\{\s*defineConfig\s*\}\s*from\s*['"]@mdrv\/kotaete['"]\s*;?\s*$/gm

function isValidDate(value: unknown): value is Date {
	return value instanceof Date && !Number.isNaN(value.getTime())
}

function normalizeDateValue(
	value: unknown,
	key: string,
	ctx = 'kotaete config',
): Date {
	if (isValidDate(value)) return value
	if (typeof value === 'string' || typeof value === 'number') {
		const parsed = new Date(value)
		if (isValidDate(parsed)) return parsed
	}
	throw new Error(`[quiz] invalid ${key} in ${ctx}: expected a valid Date value`)
}

function normalizeOptionalDateValue(
	value: unknown,
	key: string,
	ctx = 'kotaete config',
): Date | null {
	if (value === undefined || value === null) return null
	return normalizeDateValue(value, key, ctx)
}

function normalizeAnswerEntry(input: unknown, label: string, ctx: string): ConfigAnswerEntry | undefined {
	if (typeof input === 'string') {
		const trimmed = input.trim()
		if (trimmed.length === 0) return undefined
		return trimmed
	}
	if (Array.isArray(input)) {
		const results: string[] = []
		for (const item of input) {
			if (typeof item !== 'string') {
				throw new Error(`[quiz] invalid answers.${label} in ${ctx}: array items must be strings`)
			}
			const trimmed = item.trim()
			if (trimmed.length > 0) results.push(trimmed)
		}
		if (results.length === 0) return undefined
		if (results.length === 1) return results[0]
		return results
	}
	if (input && typeof input === 'object') {
		const raw = input as { text?: unknown; extraPts?: unknown }
		let textValue: string | string[]
		if (typeof raw.text === 'string') {
			const trimmed = raw.text.trim()
			if (trimmed.length === 0) {
				throw new Error(`[quiz] invalid answers.${label}.text in ${ctx}: expected non-empty string`)
			}
			textValue = trimmed
		} else if (Array.isArray(raw.text)) {
			const strings: string[] = []
			for (const item of raw.text) {
				if (typeof item !== 'string' || item.trim().length === 0) {
					throw new Error(`[quiz] invalid answers.${label}.text in ${ctx}: expected non-empty strings in array`)
				}
				strings.push(item.trim())
			}
			if (strings.length === 0) {
				throw new Error(`[quiz] invalid answers.${label}.text in ${ctx}: array must not be empty`)
			}
			textValue = strings.length === 1 ? strings[0]! : strings
		} else {
			throw new Error(`[quiz] invalid answers.${label}.text in ${ctx}: expected non-empty string`)
		}
		let extraPts: number | undefined
		if (raw.extraPts !== undefined && raw.extraPts !== null) {
			if (typeof raw.extraPts !== 'number' || !Number.isInteger(raw.extraPts) || raw.extraPts < 0) {
				throw new Error(`[quiz] invalid answers.${label}.extraPts in ${ctx}: expected non-negative integer`)
			}
			extraPts = raw.extraPts
		}
		return { text: textValue, ...(extraPts !== undefined ? { extraPts } : {}) }
	}
	return undefined
}

function normalizeQuestionAnswers(
	input: unknown,
	ctx: string,
): ConfigQuestionAnswers {
	if (!input || typeof input !== 'object') {
		throw new Error(`[quiz] invalid answers in ${ctx}: expected object`)
	}
	const raw = input as { kana?: unknown; romaji?: unknown; kanji?: unknown }

	const kana = normalizeAnswerEntry(raw.kana, 'kana', ctx)
	const romaji = normalizeAnswerEntry(raw.romaji, 'romaji', ctx)
	const kanji = normalizeAnswerEntry(raw.kanji, 'kanji', ctx)

	if (!kana && !romaji && !kanji) {
		throw new Error(`[quiz] invalid answers in ${ctx}: at least one of kana/romaji/kanji is required`)
	}

	return {
		...(kana ? { kana } : {}),
		...(romaji ? { romaji } : {}),
		...(kanji ? { kanji } : {}),
	}
}

function normalizeQuestionImage(input: unknown, ctx: string): ConfigQuestionImage {
	if (!input || typeof input !== 'object') {
		throw new Error(`[quiz] invalid image in ${ctx}: expected object`)
	}
	const raw = input as {
		credit?: unknown
		jp?: unknown
		romaji?: unknown
		god?: unknown
	}
	if (typeof raw.credit !== 'string' || raw.credit.trim().length === 0) {
		throw new Error(`[quiz] invalid image.credit in ${ctx}: expected non-empty string`)
	}
	if (typeof raw.jp !== 'string' || raw.jp.trim().length === 0) {
		throw new Error(`[quiz] invalid image.jp in ${ctx}: expected non-empty string`)
	}
	if (typeof raw.romaji !== 'string' || raw.romaji.trim().length === 0) {
		throw new Error(`[quiz] invalid image.romaji in ${ctx}: expected non-empty string`)
	}
	if (raw.god !== undefined && typeof raw.god !== 'boolean') {
		throw new Error(`[quiz] invalid image.god in ${ctx}: expected boolean`)
	}

	return {
		credit: raw.credit.trim(),
		jp: raw.jp.trim(),
		romaji: raw.romaji.trim(),
		...(raw.god === true ? { god: true } : {}),
	}
}

function normalizeQuestions(input: unknown, ctx = 'kotaete config'): ReadonlyArray<ConfigQuestion> {
	if (input === undefined || input === null) return []
	if (!Array.isArray(input)) {
		throw new Error(`[quiz] invalid questions in ${ctx}: expected array`)
	}

	return input.map((entry, index) => {
		if (!entry || typeof entry !== 'object') {
			throw new Error(`[quiz] invalid questions[${index}] in ${ctx}: expected object`)
		}
		const raw = entry as {
			no?: unknown
			hint?: unknown
			answers?: unknown
			explanation?: unknown
			extraHint?: unknown
			image?: unknown
		}

		if (typeof raw.no !== 'number' || !Number.isInteger(raw.no) || raw.no <= 0) {
			throw new Error(`[quiz] invalid questions[${index}].no in ${ctx}: expected positive integer`)
		}
		if (typeof raw.hint !== 'string' || raw.hint.trim().length === 0) {
			throw new Error(`[quiz] invalid questions[${index}].hint in ${ctx}: expected non-empty string`)
		}
		if (
			raw.explanation !== undefined
			&& raw.explanation !== null
			&& typeof raw.explanation !== 'string'
		) {
			throw new Error(`[quiz] invalid questions[${index}].explanation in ${ctx}: expected string`)
		}

		const answers = normalizeQuestionAnswers(raw.answers, `${ctx} questions[${index}]`)
		const image = raw.image === undefined ? undefined : normalizeQuestionImage(raw.image, `${ctx} questions[${index}]`)

		return {
			no: raw.no,
			hint: raw.hint.trim(),
			answers,
			...(typeof raw.explanation === 'string' && raw.explanation.trim().length > 0
				? { explanation: raw.explanation.trim() }
				: {}),
			...(image ? { image } : {}),
			...(typeof raw.extraHint === 'string' && raw.extraHint.trim().length > 0
				? { extraHint: raw.extraHint.trim() }
				: {}),
		}
	})
}

function normalizeRounds(input: unknown, ctx = 'kotaete config'): QuizScheduleConfig['rounds'] {
	if (input === undefined || input === null) return []
	if (!Array.isArray(input)) {
		throw new Error(`[quiz] invalid rounds in ${ctx}: expected array`)
	}

	return input.map((entry, index) => {
		if (!entry || typeof entry !== 'object') {
			throw new Error(`[quiz] invalid rounds[${index}] in ${ctx}: expected object`)
		}

		const raw = entry as {
			emoji?: unknown
			start?: unknown
			questionRange?: unknown
			godStage?: unknown
		}

		const start = normalizeDateValue(raw.start, `rounds[${index}].start`, ctx)
		const range = raw.questionRange
		if (!Array.isArray(range) || range.length !== 2) {
			throw new Error(`[quiz] invalid rounds[${index}].questionRange in ${ctx}: expected [from, to]`)
		}
		const from = Number(range[0])
		const to = Number(range[1])
		if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0 || from > to) {
			throw new Error(`[quiz] invalid rounds[${index}].questionRange in ${ctx}: expected positive ascending range`)
		}

		let godStage: number | null = null
		if (raw.godStage !== undefined && raw.godStage !== null) {
			const parsed = Number(raw.godStage)
			if (!Number.isInteger(parsed) || parsed <= 0) {
				throw new Error(`[quiz] invalid rounds[${index}].godStage in ${ctx}: expected positive integer`)
			}
			godStage = parsed
		}

		const emoji = typeof raw.emoji === 'string' && raw.emoji.trim().length > 0
			? raw.emoji.trim()
			: '🌟'

		return {
			emoji,
			start,
			questionRange: [from, to] as const,
			godStage,
		}
	})
}

function normalizeMessageTemplates(input: unknown): Partial<QuizMessageTemplates> {
	if (!input || typeof input !== 'object') return {}
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(input)) {
		if (typeof value === 'string') out[key] = value
	}
	return out as Partial<QuizMessageTemplates>
}

function normalizeTemplateConfig(input: unknown): { default?: string; god?: string } {
	if (!input || typeof input !== 'object') return {}
	const raw = input as { default?: unknown; god?: unknown }
	const out: { default?: string; god?: string } = {}
	if (typeof raw.default === 'string' && raw.default.trim().length > 0) {
		out.default = raw.default.trim()
	}
	if (typeof raw.god === 'string' && raw.god.trim().length > 0) {
		out.god = raw.god.trim()
	}
	return out
}

function normalizeSeason(input: unknown): SeasonConfig | null {
	if (!input || typeof input !== 'object') return null
	const raw = input as { id?: unknown; start?: unknown; end?: unknown; caption?: unknown; scoreboardTemplate?: unknown }
	const season: SeasonConfig = {}
	if (typeof raw.id === 'string' && raw.id.trim().length > 0) season.id = raw.id.trim()
	if (raw.start === true) season.start = true
	if (raw.end === true) season.end = true
	if (typeof raw.caption === 'string' && raw.caption.trim().length > 0) {
		season.caption = raw.caption.trim()
	}
	if (typeof raw.scoreboardTemplate === 'string' && raw.scoreboardTemplate.trim().length > 0) {
		season.scoreboardTemplate = raw.scoreboardTemplate.trim()
	}
	return season
}

function normalizeMembers(input: unknown): ReadonlyArray<NMember> | string | null {
	if (input === undefined || input === null) return null
	if (typeof input === 'string') {
		const trimmed = input.trim()
		return trimmed.length > 0 ? trimmed : null
	}
	if (Array.isArray(input)) {
		return input as ReadonlyArray<NMember>
	}
	throw new Error('[quiz] invalid members in kotaete config: expected string path or array')
}

function normalizeTunables(input?: QuizTunablesInput): QuizTunables {
	const t = QUIZ_TUNABLES
	return {
		timeout: { ...t.timeout, ...input?.timeout },
		cooldown: { ...t.cooldown, ...input?.cooldown },
		points: { ...t.points, ...input?.points },
		wrongAttempts: {
			...t.wrongAttempts,
			...(input?.wrongAttempts?.emojiStreak != null
				? { emojiStreak: input.wrongAttempts.emojiStreak }
				: {}),
			...(input?.wrongAttempts?.maxCount != null
				? { maxCount: input.wrongAttempts.maxCount }
				: {}),
		},
	}
}

export function defineConfig(config: QuizScheduleConfigInput = {}): QuizScheduleConfig {
	const fromImageTemplates = normalizeTemplateConfig(config.imageTemplates)
	const fromTemplatesAlias = normalizeTemplateConfig(config.templates)
	const template = typeof config.template === 'string' && config.template.trim().length > 0
		? config.template.trim()
		: undefined
	const templateGod = typeof config.templateGod === 'string' && config.templateGod.trim().length > 0
		? config.templateGod.trim()
		: undefined

	const groupId = typeof config.groupId === 'string' && config.groupId.trim().length > 0
		? config.groupId.trim()
		: null

	return {
		intro: normalizeOptionalDateValue(config.intro, 'intro'),
		start: normalizeOptionalDateValue(config.start, 'start'),
		rounds: normalizeRounds(config.rounds),
		messages: normalizeMessageTemplates(config.messages),
		questions: normalizeQuestions(config.questions),
		groupId,
		members: normalizeMembers(config.members),
		imageTemplates: {
			...fromTemplatesAlias,
			...fromImageTemplates,
			...(template ? { default: template } : {}),
			...(templateGod ? { god: templateGod } : {}),
		},
		season: normalizeSeason(config.season),
		tunables: normalizeTunables(config.tunables),
	}
}

const CJK_IDEOGRAPH_RE = /[\u4e00-\u9fff]/

function inferAnswerOptions(answers: string[]): { text: string; kanjiExtraPts: number | undefined } {
	const hasKana = answers.length > 0
	const hasRomaji = answers.some((a) => /^[a-zA-Z]/.test(a))
	const hasKanji = answers.some((a) => CJK_IDEOGRAPH_RE.test(a))
	const kanjiExtra = hasKanji && answers.some((a) => /\+\d/.test(a))
	const extraPtsMatch = kanjiExtra
		? answers.find((a) => /\+(\d+)/.test(a))?.match(/\+(\d+)/)
		: null
	const extraPts = extraPtsMatch ? Number(extraPtsMatch[1]) : undefined

	const kanjiIcon = hasKanji && extraPts ? '🌸' : (hasKanji ? '✅' : '❌')

	const text = [
		'*Opsi jawab:*',
		`${hasKana ? '✅' : '❌'} かな (kana)`,
		`${hasRomaji ? '✅' : '❌'} romaji + jenis kana`,
		`${kanjiIcon} 漢字 (kanji)${extraPts ? ` *+${extraPts}pts*` : ''}`,
	].join('\n')

	return { text, kanjiExtraPts: extraPts }
}

function parseQuestionMarkdown(markdown: string): {
	text: string
	answers: string[]
	explanation: string
	kanjiExtraPts: number | undefined
} {
	const sections = markdown.split(SECTION_SEP)

	let text = sections[0]?.trim() ?? ''
	if (text.length === 0) {
		throw new Error('question text (first section before ---) is empty')
	}

	// Remove leading "Hint:" / "hint:" / "*Hint:*" prefix and old "*Opsi jawab:*" block for formatting parity with scheduled path
	text = text.replace(/^[\*_]*[Hh]int:?[\*_]*\s*/i, '').trimStart()
	text = text.replace(/[\s\r\n]*[\*_]*Opsi jawab:?[\*_]*[\s\S]*$/i, '').trimEnd()

	if (text.length === 0) {
		throw new Error('question text is empty after removing Hint: prefix')
	}

	const rawAnswerLines = sections[1]
		?.trim()
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => line.trim()) ?? []

	if (rawAnswerLines.length === 0) {
		throw new Error(
			'answers section (second section after first ---) is empty or missing',
		)
	}

	// Strip inline extra-points markers (e.g. "漢字 +2") from answer text
	const answerLines = rawAnswerLines.map((line) => line.replace(/\s*\+\d+\s*$/, '').trim()).filter(Boolean)

	if (answerLines.length === 0) {
		throw new Error(
			'answers section (second section after first ---) is empty after stripping markers',
		)
	}

	const explanation = sections[2]?.trim() ?? ''

	const optionsBlock = inferAnswerOptions(rawAnswerLines)
	const formattedText = `${text}\n\n${optionsBlock.text}`

	return { text: formattedText, answers: answerLines, explanation, kanjiExtraPts: optionsBlock.kanjiExtraPts }
}

function extractQuestionNumber(filename: string): number | null {
	const name = basename(filename, '.md')

	const trailing = name.match(/-(\d+)$/)
	if (trailing) return Number(trailing[1])

	const plain = name.match(/^(\d+)$/)
	if (plain) return Number(plain[1])

	return null
}

function questionNumberStems(number: number): string[] {
	const plain = String(number)
	const padded = plain.padStart(2, '0')
	return padded === plain ? [plain] : [padded, plain]
}

async function isFile(path: string): Promise<boolean> {
	try {
		const s = await stat(path)
		return s.isFile()
	} catch {
		return false
	}
}

async function resolveImagePathByStem(dir: string, stem: string): Promise<string | null> {
	for (const candidateStem of [`${stem}-ok`, stem]) {
		for (const ext of IMAGE_EXTS) {
			const candidate = resolve(dir, `${candidateStem}${ext}`)
			if (await isFile(candidate)) return candidate
		}
	}
	return null
}

async function resolveImagePathByQuestionNumber(
	dir: string,
	questionNumber: number,
): Promise<string | null> {
	for (const stem of questionNumberStems(questionNumber)) {
		const found = await resolveImagePathByStem(dir, stem)
		if (found) return found
	}
	return null
}

async function resolveImagePathForMarkdownFile(
	dir: string,
	markdownFilename: string,
): Promise<string | null> {
	const stem = basename(markdownFilename, '.md')
	return await resolveImagePathByStem(dir, stem)
}

function expandHome(input: string): string {
	if (input === '~') return process.env.HOME ?? input
	if (input.startsWith('~/')) {
		return `${process.env.HOME ?? '~'}/${input.slice(2)}`
	}
	return input
}

function resolvePathMaybeRelative(value: string, baseDir: string): string {
	const expanded = expandHome(value)
	return expanded.startsWith('/') ? resolve(expanded) : resolve(baseDir, expanded)
}

type SourceConfigPart = {
	baseDir: string
	input: QuizScheduleConfigInput
}

function normalizeRawConfigValue(
	raw: unknown,
	sourcePath: string,
): QuizScheduleConfigInput {
	if (Array.isArray(raw)) {
		return { members: raw as ReadonlyArray<NMember> }
	}
	if (raw && typeof raw === 'object') {
		return raw as QuizScheduleConfigInput
	}
	throw new Error(
		`[quiz] ${sourcePath} must default-export an object/array (or defineConfig({...}))`,
	)
}

async function loadConfigFileInput(
	absPath: string,
	opts?: { requireDefineImport?: boolean },
): Promise<QuizScheduleConfigInput> {
	const ext = extname(absPath).toLowerCase()
	if (ext === '.json') {
		const raw = JSON.parse(await readFile(absPath, 'utf-8')) as unknown
		return normalizeRawConfigValue(raw, absPath)
	}

	if (ext !== '.ts' && ext !== '.js' && ext !== '.mjs' && ext !== '.cjs') {
		throw new Error(
			`[quiz] unsupported config source extension "${ext}" for "${absPath}"`,
		)
	}

	const source = await readFile(absPath, 'utf-8')
	const stripped = source.replace(CONFIG_IMPORT_RE, '')
	if (opts?.requireDefineImport && stripped === source) {
		throw new Error('[quiz] kotaete.ts must import defineConfig from "@mdrv/kotaete"')
	}

	const tsModule = `const defineConfig = (config) => config\n${stripped}`
	let jsModule = tsModule
	try {
		jsModule = new Bun.Transpiler({ loader: 'ts' }).transformSync(tsModule)
	} catch (error) {
		throw new Error(
			`[quiz] failed to transpile ${basename(absPath)}: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	const specifier = `data:text/javascript;base64,${Buffer.from(jsModule, 'utf-8').toString('base64')}`
	let mod: { default?: unknown }
	try {
		mod = (await import(specifier)) as { default?: unknown }
	} catch (error) {
		// Bun's import resolver has a NameTooLong limit on data: URLs.
		// Fall back to writing a temp .mjs file.
		if (String(error).includes('NameTooLong') || String(error).includes('name too long')) {
			const tmpFile = join(tmpdir(), `kotaete-config-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
			await writeFile(tmpFile, jsModule, 'utf-8')
			try {
				const fileUrl = pathToFileURL(tmpFile).href
				mod = (await import(fileUrl)) as { default?: unknown }
			} finally {
				await unlink(tmpFile).catch(() => undefined)
			}
		} else {
			throw error
		}
	}
	if (typeof mod.default === 'undefined') {
		throw new Error(`[quiz] ${absPath} must have a default export`)
	}

	return normalizeRawConfigValue(mod.default, absPath)
}

async function loadConfigFromDirectory(
	absDir: string,
	opts?: { required?: boolean },
): Promise<SourceConfigPart | null> {
	const configPath = resolve(absDir, 'kotaete.ts')
	if (!(await isFile(configPath))) {
		if (opts?.required) {
			throw new Error(`[quiz] missing kotaete.ts schedule config in "${absDir}"`)
		}
		return null
	}

	const input = await loadConfigFileInput(configPath, { requireDefineImport: true })
	return {
		baseDir: absDir,
		input,
	}
}

function mergeConfigInputs(parts: ReadonlyArray<SourceConfigPart>): QuizScheduleConfigInput {
	const merged: QuizScheduleConfigInput = {}

	for (const part of parts) {
		const patch = part.input

		if (Object.hasOwn(patch, 'intro') && patch.intro !== undefined) {
			merged.intro = patch.intro
		}
		if (Object.hasOwn(patch, 'start') && patch.start !== undefined) {
			merged.start = patch.start
		}
		if (
			Object.hasOwn(patch, 'groupId')
			&& typeof patch.groupId === 'string'
		) {
			merged.groupId = patch.groupId
		}

		if (Object.hasOwn(patch, 'members') && patch.members !== undefined) {
			if (typeof patch.members === 'string') {
				merged.members = resolvePathMaybeRelative(patch.members, part.baseDir)
			} else {
				merged.members = patch.members
			}
		}

		if (patch.rounds !== undefined) merged.rounds = patch.rounds
		if (patch.questions !== undefined) merged.questions = patch.questions

		if (patch.messages !== undefined) {
			merged.messages = {
				...(merged.messages ?? {}),
				...patch.messages,
			}
		}

		if (patch.season !== undefined) {
			merged.season = {
				...(merged.season ?? {}),
				...patch.season,
			}
		}

		const nextImageTemplates = {
			...(merged.imageTemplates ?? {}),
			...(patch.templates ?? {}),
			...(patch.imageTemplates ?? {}),
		}

		if (typeof patch.template === 'string' && patch.template.trim().length > 0) {
			nextImageTemplates.default = resolvePathMaybeRelative(patch.template, part.baseDir)
		}
		if (typeof patch.templateGod === 'string' && patch.templateGod.trim().length > 0) {
			nextImageTemplates.god = resolvePathMaybeRelative(patch.templateGod, part.baseDir)
		}

		if (typeof nextImageTemplates.default === 'string') {
			nextImageTemplates.default = resolvePathMaybeRelative(nextImageTemplates.default, part.baseDir)
		}
		if (typeof nextImageTemplates.god === 'string') {
			nextImageTemplates.god = resolvePathMaybeRelative(nextImageTemplates.god, part.baseDir)
		}

		merged.imageTemplates = nextImageTemplates
	}

	return merged
}

type SourceEntry = {
	path: string
	kind: 'file' | 'dir'
}

async function classifySource(input: string): Promise<SourceEntry> {
	const abs = resolve(expandHome(input))
	const s = await stat(abs).catch(() => null)
	if (!s) throw new Error(`[quiz] source not found: "${input}"`)
	if (s.isDirectory()) return { path: abs, kind: 'dir' }
	if (s.isFile()) return { path: abs, kind: 'file' }
	throw new Error(`[quiz] unsupported source type (not file/dir): "${input}"`)
}

function uniqueAnswers(input: ReadonlyArray<string>): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const item of input) {
		const normalized = item.trim()
		if (!normalized || seen.has(normalized)) continue
		seen.add(normalized)
		out.push(normalized)
	}
	return out
}

function formatAnswerOptionsBlock(answers: ConfigQuestionAnswers): string {
	const kanaEntry = answers.kana != null ? answers.kana : null
	const romajiEntry = answers.romaji != null ? answers.romaji : null
	const kanjiEntry = answers.kanji != null ? answers.kanji : null

	const hasKana = kanaEntry !== null
	const hasRomaji = romajiEntry !== null
	const hasKanji = kanjiEntry !== null

	const kanaExtraPts = getAnswerExtraPts(kanaEntry)
	const romajiExtraPts = getAnswerExtraPts(romajiEntry)
	const kanjiExtraPts = getAnswerExtraPts(kanjiEntry)

	const kanaIcon = hasKana ? (kanaExtraPts > 0 ? '🌸' : '✅') : '❌'
	const romajiIcon = hasRomaji ? (romajiExtraPts > 0 ? '🌸' : '✅') : '❌'
	const kanjiIcon = hasKanji ? (kanjiExtraPts > 0 ? '🌸' : '✅') : '❌'

	return [
		'*Opsi jawab:*',
		`${kanaIcon} かな (kana)${kanaExtraPts > 0 ? ` *+${kanaExtraPts}pts*` : ''}`,
		`${romajiIcon} romaji + jenis kana${romajiExtraPts > 0 ? ` *+${romajiExtraPts}pts*` : ''}`,
		`${kanjiIcon} 漢字 (kanji)${kanjiExtraPts > 0 ? ` *+${kanjiExtraPts}pts*` : ''}`,
	].join('\n')
}

/** Extract all answer texts from a ConfigAnswerEntry (handles string, string[], object) */
function getAnswerTexts(entry: ConfigAnswerEntry | undefined | null): string[] {
	if (entry == null) return []
	if (typeof entry === 'string') return [entry]
	if (Array.isArray(entry)) return entry
	// object form: { text: string | string[], extraPts? }
	if (typeof entry.text === 'string') return [entry.text]
	if (Array.isArray(entry.text)) return entry.text
	return []
}

/** Get extraPts from a ConfigAnswerEntry (0 for plain strings/arrays) */
function getAnswerExtraPts(entry: ConfigAnswerEntry | undefined | null): number {
	if (entry == null) return 0
	if (typeof entry === 'string') return 0
	if (Array.isArray(entry)) return 0
	return entry.extraPts ?? 0
}

function convertConfigQuestion(entry: ConfigQuestion): QuizQuestion {
	const kanaTexts = getAnswerTexts(entry.answers.kana)
	const romajiTexts = getAnswerTexts(entry.answers.romaji)
	const kanjiTexts = getAnswerTexts(entry.answers.kanji)

	const answers = uniqueAnswers([...kanaTexts, ...romajiTexts, ...kanjiTexts])

	// Build a map from each answer string to its per-type extraPts
	const answerExtraPts = new Map<string, number>()
	const kanaPts = getAnswerExtraPts(entry.answers.kana)
	const romajiPts = getAnswerExtraPts(entry.answers.romaji)
	const kanjiPts = getAnswerExtraPts(entry.answers.kanji)
	for (const t of kanaTexts) answerExtraPts.set(t, kanaPts)
	for (const t of romajiTexts) answerExtraPts.set(t, romajiPts)
	for (const t of kanjiTexts) answerExtraPts.set(t, kanjiPts)

	const extraPts = Math.max(kanaPts, romajiPts, kanjiPts)
	const hasKanji = entry.answers.kanji != null

	return {
		number: entry.no,
		text: `${entry.hint}\n\n${formatAnswerOptionsBlock(entry.answers)}`,
		answers,
		...(hasKanji ? { kanjiAnswers: kanjiTexts as ReadonlyArray<string> } : {}),
		...(extraPts > 0 ? { extraPts } : {}),
		...(answerExtraPts.size > 0 ? { answerExtraPts } : {}),
		...(entry.extraHint ? { extraHint: entry.extraHint } : {}),
		explanation: entry.explanation ?? '',
		imagePath: null,
		isSpecialStage: false,
	}
}
function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;')
}

async function findBaseImageForQuestion(dir: string, questionNumber: number): Promise<string | null> {
	for (const stem of questionNumberStems(questionNumber)) {
		for (const ext of IMAGE_EXTS) {
			const candidate = resolve(dir, `${stem}${ext}`)
			if (await isFile(candidate)) return candidate
		}
	}
	return null
}

async function renderQuestionSvgTemplate(
	templatePath: string,
	imageMeta: ConfigQuestionImage,
	sourceImagePath: string,
): Promise<string> {
	const svgSource = await readFile(templatePath, 'utf-8')
	const sourceHref = pathToFileURL(sourceImagePath).href

	let rendered = svgSource
		.replaceAll('{{credit}}', escapeXml(imageMeta.credit))
		.replaceAll('{{jp}}', escapeXml(imageMeta.jp))
		.replaceAll('{{romaji}}', escapeXml(imageMeta.romaji))

	// Replace href only for the intended question image, not all href attributes
	// (e.g. backgrounds, embedded objects) that may reference other resources.
	const PLACEHOLDER_RE = /\{\{(image|sourceImage|__IMAGE__)\}\}/i
	const placeholderMatch = rendered.match(PLACEHOLDER_RE)

	if (placeholderMatch) {
		// Template uses explicit placeholder(s) — replace those specifically
		rendered = rendered.replace(
			PLACEHOLDER_RE,
			sourceHref,
		)
	} else {
		// No explicit placeholder — replace only the first href/xlink:href inside an
		// <image ...> element (the base question image), preserving all other refs.
		let imageHrefReplaced = false
		rendered = rendered.replace(
			/<image\b[^>]*(xlink:href|href)\s*=\s*(["'])[^"']*\2/g,
			(fullMatch: string, attr: string, quote: string) => {
				if (imageHrefReplaced) return fullMatch
				imageHrefReplaced = true
				return fullMatch.replace(
					/(xlink:href|href)\s*=\s*(["'])[^"']*\2/,
					`${attr}=${quote}${sourceHref}${quote}`,
				)
			},
		)
	}

	// Align sodipodi:absref only once (for the question image we just replaced)
	rendered = rendered.replace(
		/sodipodi:absref\s*=\s*(["'])[^"']*\1/,
		(_full, quote: string) => `sodipodi:absref=${quote}${sourceImagePath}${quote}`,
	)

	return rendered
}

export type ImageExportOptions = {
	saveSvg?: boolean
}

/**
 * Build inkscape CLI arguments for PNG export via Inkscape.
 * Extracted for testability without requiring inkscape binary.
 */
export function buildInkscapeArgs(outputPath: string, tmpSvgPath: string): string[] {
	return [
		'inkscape',
		`--export-filename=${outputPath}`,
		'--export-type=png',
		'--export-background=#ffffff',
		'--export-background-opacity=1',
		'--export-png-color-mode=RGB_8',
		tmpSvgPath,
	]
}

/**
 * Build ImageMagick args to convert PNG to compressed JPG.
 */
export function buildMagickJpgArgs(inputPngPath: string, outputJpgPath: string, quality = 85): string[] {
	return [
		'magick',
		inputPngPath,
		'-quality',
		String(quality),
		outputJpgPath,
	]
}

/**
 * Determine output file paths for template-based exports.
 * Keeps both PNG and JPG variants side by side.
 */
export function resolveImageExportPaths(outputStem: string): { pngPath: string; jpgPath: string; svgDestPath: string } {
	const extension = extname(outputStem)
	const stem = extension.length > 0
		? outputStem.slice(0, -extension.length)
		: outputStem
	return {
		pngPath: `${stem}.png`,
		jpgPath: `${stem}.jpg`,
		svgDestPath: `${stem}.svg`,
	}
}

async function exportSvgToImage(
	svgContent: string,
	outputStem: string,
	opts?: ImageExportOptions,
): Promise<{ pngPath: string; jpgPath: string }> {
	const { pngPath, jpgPath, svgDestPath } = resolveImageExportPaths(outputStem)
	const tmpSvgPath = join(tmpdir(), `kotaete-template-${Date.now()}-${Math.random().toString(36).slice(2)}.svg`)
	await writeFile(tmpSvgPath, svgContent, 'utf-8')
	try {
		const inkscapeArgs = buildInkscapeArgs(pngPath, tmpSvgPath)
		const inkscapeProc = Bun.spawn(inkscapeArgs, { stdout: 'pipe', stderr: 'pipe' })
		const inkscapeCode = await inkscapeProc.exited
		if (inkscapeCode !== 0) {
			const stderr = inkscapeProc.stderr ? await new Response(inkscapeProc.stderr).text() : ''
			throw new Error(stderr.trim() || `inkscape exited with code ${inkscapeCode}`)
		}

		if (!(await isFile(pngPath))) {
			throw new Error(`inkscape did not produce PNG output: ${pngPath}`)
		}

		const magickArgs = buildMagickJpgArgs(pngPath, jpgPath, 85)
		const magickProc = Bun.spawn(magickArgs, { stdout: 'pipe', stderr: 'pipe' })
		const magickCode = await magickProc.exited
		if (magickCode !== 0) {
			const stderr = magickProc.stderr ? await new Response(magickProc.stderr).text() : ''
			throw new Error(stderr.trim() || `magick exited with code ${magickCode}`)
		}

		if (!(await isFile(jpgPath))) {
			throw new Error(`magick did not produce JPG output: ${jpgPath}`)
		}
	} catch (error) {
		throw new Error(
			`[quiz] failed generating image with Inkscape: ${error instanceof Error ? error.message : String(error)}`,
		)
	} finally {
		if (opts?.saveSvg) {
			await writeFile(svgDestPath, svgContent, 'utf-8').catch(() => undefined)
		}
		await unlink(tmpSvgPath).catch(() => undefined)
	}

	return { pngPath, jpgPath }
}

async function generateQuestionImages(
	quizDir: string,
	configQuestions: ReadonlyArray<ConfigQuestion>,
	imageTemplates: QuizScheduleConfig['imageTemplates'],
	opts?: ImageExportOptions,
): Promise<Map<number, string>> {
	const home = process.env.HOME ?? '~'
	const defaultTemplate = resolvePathMaybeRelative(
		imageTemplates.default ?? `${home}/.kotaete/template.svg`,
		quizDir,
	)
	const godTemplateCandidate = imageTemplates.god
		? resolvePathMaybeRelative(imageTemplates.god, quizDir)
		: resolvePathMaybeRelative(`${home}/.kotaete/template-god.svg`, quizDir)

	const generated = new Map<number, string>()

	for (const question of configQuestions) {
		if (!question.image) continue

		const sourceImage = await findBaseImageForQuestion(quizDir, question.no)
		if (!sourceImage) {
			throw new Error(`[quiz] missing base image for question ${question.no} in "${quizDir}"`)
		}

		const templatePath = question.image.god ? godTemplateCandidate : defaultTemplate
		if (!(await isFile(templatePath))) {
			throw new Error(`[quiz] missing SVG template: "${templatePath}"`)
		}

		const outputStem = questionNumberStems(question.no)[0] ?? String(question.no)
		const outputPathStem = resolve(quizDir, `${outputStem}-ok`)
		const rendered = await renderQuestionSvgTemplate(templatePath, question.image, sourceImage)
		const exported = await exportSvgToImage(rendered, outputPathStem, opts)
		generated.set(question.no, exported.jpgPath)
	}

	return generated
}

function buildRoundsFromSchedule(
	schedule: QuizScheduleConfig,
	questions: ReadonlyArray<QuizQuestion>,
	startFallback: Date,
	noSchedule: boolean,
): ReadonlyArray<QuizRound> {
	if (schedule.rounds.length === 0) {
		return [{ emoji: '🌟', startAt: startFallback, questions }]
	}

	const byNumber = new Map<number, QuizQuestion>(questions.map((q) => [q.number, q]))
	const seen = new Set<number>()

	return schedule.rounds.map((round) => {
		const picked: QuizQuestion[] = []
		const [from, to] = round.questionRange

		for (let number = from; number <= to; number += 1) {
			const question = byNumber.get(number)
			if (!question) {
				throw new Error(`[quiz] round references missing question: ${number}`)
			}
			if (seen.has(number)) {
				throw new Error(`[quiz] duplicate question across rounds: ${number}`)
			}
			seen.add(number)
			picked.push(question)
		}

		if (round.godStage !== null) {
			const godQuestion = byNumber.get(round.godStage)
			if (!godQuestion) {
				throw new Error(`[quiz] round godStage references missing question: ${round.godStage}`)
			}
			if (seen.has(round.godStage)) {
				throw new Error(`[quiz] duplicate question across rounds: ${round.godStage}`)
			}
			seen.add(round.godStage)
			godQuestion.isSpecialStage = true
			picked.push(godQuestion)
		}

		return {
			emoji: round.emoji,
			startAt: noSchedule ? startFallback : round.start,
			questions: picked,
		}
	})
}

async function detectIntroNote(dir: string, dirBasename: string): Promise<string | null> {
	const directIntro = resolve(dir, 'intro.md')
	if (await isFile(directIntro)) {
		return await readFile(directIntro, 'utf-8')
	}

	const datePrefix = dirBasename.slice(0, 8)
	const candidates = [
		`${dirBasename}-0-start.md`,
		`${datePrefix}-0-start.md`,
		'0-start.md',
		'start.md',
	]

	for (const name of candidates) {
		const abs = resolve(dir, name)
		if (await isFile(abs)) {
			return await readFile(abs, 'utf-8')
		}
	}

	return null
}

async function detectOutroNote(dir: string): Promise<string | null> {
	const path = resolve(dir, 'outro.md')
	if (!(await isFile(path))) return null
	return await readFile(path, 'utf-8')
}

async function loadMarkdownQuestions(absDir: string, dirBasename: string): Promise<QuizQuestion[]> {
	const allFiles = await readdir(absDir)
	const mdFiles = allFiles.filter((f) => f.endsWith('.md'))

	const datePrefix = dirBasename.slice(0, 8)
	const introCandidateNames = new Set([
		`${dirBasename}-0-start.md`,
		`${datePrefix}-0-start.md`,
		'0-start.md',
		'start.md',
		'intro.md',
		'outro.md',
	])

	const questionFiles = mdFiles.filter((f) => !introCandidateNames.has(f))
	const questions: QuizQuestion[] = []

	for (const mdFile of questionFiles) {
		const number = extractQuestionNumber(mdFile)
		if (number === null) continue

		const raw = await readFile(resolve(absDir, mdFile), 'utf-8')
		const { text, answers, explanation, kanjiExtraPts } = parseQuestionMarkdown(raw)
		const imagePath = await resolveImagePathForMarkdownFile(absDir, mdFile)

		questions.push({
			number,
			text,
			answers,
			...(kanjiExtraPts !== undefined ? { kanjiExtraPts } : {}),
			explanation,
			imagePath,
			isSpecialStage: false,
		})
	}

	questions.sort((a, b) => a.number - b.number)
	return questions
}

type LoadInputResolution = {
	quizDir: string
	sources: string[]
	mergedSchedule: QuizScheduleConfig
	hasPrimaryDirectoryConfig: boolean
}

async function resolveLoadInput(
	quizDirOrSources: string | ReadonlyArray<string>,
	noSchedule: boolean,
): Promise<LoadInputResolution> {
	if (Array.isArray(quizDirOrSources)) {
		if (quizDirOrSources.length === 0) {
			throw new Error('[quiz] run sources must contain at least one file or directory')
		}

		const entries = await Promise.all(quizDirOrSources.map((source) => classifySource(source)))
		const quizDir = [...entries].reverse().find((entry) => entry.kind === 'dir')?.path
		if (!quizDir) {
			throw new Error('[quiz] run sources must include at least one quiz directory')
		}

		const parts: SourceConfigPart[] = []
		for (const entry of entries) {
			if (entry.kind === 'dir') {
				const loaded = await loadConfigFromDirectory(entry.path)
				if (loaded) parts.push(loaded)
				continue
			}

			const input = await loadConfigFileInput(entry.path)
			parts.push({
				baseDir: dirname(entry.path),
				input,
			})
		}

		return {
			quizDir,
			sources: entries.map((entry) => entry.path),
			mergedSchedule: defineConfig(mergeConfigInputs(parts)),
			hasPrimaryDirectoryConfig: parts.some((part) => part.baseDir === quizDir),
		}
	}

	const absDir = resolve(expandHome(quizDirOrSources as string))
	const dirConfig = await loadConfigFromDirectory(absDir, { required: !noSchedule })
	const mergedSchedule = defineConfig(mergeConfigInputs(dirConfig ? [dirConfig] : []))

	return {
		quizDir: absDir,
		sources: [absDir],
		mergedSchedule,
		hasPrimaryDirectoryConfig: Boolean(dirConfig),
	}
}

/**
 * Load a full `QuizBundle` from either a quiz directory or cascading config sources.
 */
export async function loadQuizBundle(
	quizDirOrSources: string | ReadonlyArray<string>,
	opts?: { noSchedule?: boolean; noGeneration?: boolean; saveSvg?: boolean },
): Promise<QuizBundle> {
	const noSchedule = opts?.noSchedule === true
	const noGeneration = opts?.noGeneration === true
	const resolved = await resolveLoadInput(quizDirOrSources, noSchedule)
	const absDir = resolved.quizDir
	const dirBasename = basename(absDir)
	const schedule = resolved.mergedSchedule

	let introAt: Date
	let startAt: Date

	if (noSchedule) {
		const now = new Date()
		introAt = now
		startAt = now
	} else {
		if (!resolved.hasPrimaryDirectoryConfig && Array.isArray(quizDirOrSources) === false) {
			throw new Error(`[quiz] missing kotaete.ts schedule config in "${absDir}"`)
		}
		if (!schedule.intro) {
			throw new Error('[quiz] kotaete.ts config must contain "intro" (or pass --no-schedule)')
		}
		const resolvedStart = schedule.start ?? schedule.rounds[0]?.start ?? null
		if (!resolvedStart) {
			throw new Error('[quiz] kotaete.ts config must contain "start" or at least one round start')
		}
		introAt = schedule.intro
		startAt = resolvedStart
	}

	const introNote = schedule.messages.intro ?? await detectIntroNote(absDir, dirBasename)
	const outroNote = schedule.messages.outro ?? await detectOutroNote(absDir)

	let questions: QuizQuestion[]
	let rounds: ReadonlyArray<QuizRound>

	if (schedule.questions.length > 0) {
		const imageExportOpts: ImageExportOptions = {
			...(opts?.saveSvg ? { saveSvg: true } : {}),
		}
		const generated = noGeneration
			? new Map<number, string>()
			: await generateQuestionImages(absDir, schedule.questions, schedule.imageTemplates, imageExportOpts)
		questions = await Promise.all(
			schedule.questions.map(async (entry) => {
				const converted = convertConfigQuestion(entry)
				const imagePath = generated.get(entry.no) ?? (await resolveImagePathByQuestionNumber(absDir, entry.no))
				return {
					...converted,
					imagePath,
				}
			}),
		)
		questions.sort((a, b) => a.number - b.number)
		rounds = buildRoundsFromSchedule(schedule, questions, startAt, noSchedule)
	} else {
		questions = await loadMarkdownQuestions(absDir, dirBasename)
		rounds = [{ emoji: '🌟', startAt, questions }]
	}

	if (questions.length === 0) {
		throw new Error('[quiz] no question markdown files found in quiz directory')
	}

	const members = Array.isArray(schedule.members)
		? schedule.members
		: null
	const membersFile = typeof schedule.members === 'string'
		? schedule.members
		: null

	return {
		directory: absDir,
		sources: resolved.sources,
		introAt,
		startAt,
		rounds,
		introNote,
		outroNote,
		messageTemplates: schedule.messages,
		questions,
		groupId: schedule.groupId,
		members,
		membersFile,
		season: schedule.season ?? null,
		tunables: schedule.tunables,
	}
}
