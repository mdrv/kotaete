import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	buildInkscapeArgs,
	buildMagickJpgArgs,
	defineConfig,
	loadQuizBundle,
	resolveImageExportPaths,
} from './loader.ts'

let sandboxDir = ''

beforeAll(async () => {
	sandboxDir = await mkdtemp(join(tmpdir(), 'kotaete-loader-test-'))
})

afterAll(async () => {
	if (sandboxDir) await rm(sandboxDir, { recursive: true, force: true })
})

async function writeQuizDir(name: string, files: Record<string, string>): Promise<string> {
	const dir = join(sandboxDir, name)
	await mkdir(dir, { recursive: true })
	for (const [relativePath, content] of Object.entries(files)) {
		await writeFile(join(dir, relativePath), content, 'utf-8')
	}
	return dir
}

function makeConfigKotaeteTs(overrides: Record<string, string> = {}): string {
	const defaults: Record<string, string> = {
		questions: [
			'  questions: [',
			'    { no: 1, hint: "What is あ?", answers: { kana: "あ", romaji: "a", kanji: { text: "亜", extraPts: 2 } }, explanation: "Hiragana a" },',
			'  ],',
		].join('\n'),
		rounds: [
			'  rounds: [',
			'    { emoji: "🌅", start: new Date("2026-04-04T08:00:00+07:00"), questionRange: [1, 1] },',
			'  ],',
		].join('\n'),
		intro: "  intro: new Date('2026-04-04T07:50:00+07:00'),",
	}
	const merged = { ...defaults, ...overrides }
	const lines = [
		"import { defineConfig } from '@mdrv/kotaete'",
		'',
		'export default defineConfig({',
		merged.intro,
		merged.rounds,
		merged.questions,
	]
	if (merged.messages) {
		lines.push(merged.messages)
	}
	lines.push('})')
	return lines.join('\n')
}

describe('defineConfig', () => {
	test('normalizes valid date-like values', () => {
		const config = defineConfig({
			intro: '2026-04-04T07:50:00+07:00',
			start: new Date('2026-04-04T08:00:00+07:00'),
			rounds: [
				{
					emoji: '🌅',
					start: '2026-04-04T08:00:00+07:00',
					questionRange: [1, 2],
				},
			],
		})

		expect(config.intro instanceof Date).toBe(true)
		expect(config.start instanceof Date).toBe(true)
		expect(config.rounds[0]?.start instanceof Date).toBe(true)
		expect(Number.isNaN((config.intro as Date).getTime())).toBe(false)
		expect(Number.isNaN((config.start as Date).getTime())).toBe(false)
		expect(config.questions).toEqual([])
	})

	test('passes through questions', () => {
		const config = defineConfig({
			intro: '2026-04-04T07:50:00+07:00',
			questions: [
				{ no: 1, hint: 'test', answers: { kana: 'あ' } },
			],
		})
		expect(config.questions).toHaveLength(1)
		expect(config.questions[0]?.no).toBe(1)
		expect(config.questions[0]?.hint).toBe('test')
		expect(config.questions[0]?.answers.kana).toEqual({ text: 'あ', extraPts: 0 })
	})

	test('throws on invalid values', () => {
		expect(() => defineConfig({ intro: 'invalid-date', start: new Date() })).toThrow()
	})

	test('normalizes season config with start and end', () => {
		const config = defineConfig({
			season: { start: true, end: true, caption: 'Week 1', scoreboardTemplate: '~/template.svg' },
		})
		expect(config.season).toBeTruthy()
		expect(config.season?.start).toBe(true)
		expect(config.season?.end).toBe(true)
		expect(config.season?.caption).toBe('Week 1')
		expect(config.season?.scoreboardTemplate).toBe('~/template.svg')
	})

	test('normalizes season config with only end', () => {
		const config = defineConfig({
			season: { end: true },
		})
		expect(config.season).toBeTruthy()
		expect(config.season?.start).toBeUndefined()
		expect(config.season?.end).toBe(true)
	})

	test('season is null when not provided', () => {
		const config = defineConfig({})
		expect(config.season).toBeNull()
	})

	test('season is preserved as empty object when season key exists', () => {
		const config = defineConfig({ season: {} })
		expect(config.season).not.toBeNull()
		expect(config.season).toEqual({})
	})

	test('season caption trimmed', () => {
		const config = defineConfig({
			season: { caption: '  Week 2  ' },
		})
		expect(config.season?.caption).toBe('Week 2')
	})
})

describe('loadQuizBundle schedule behavior', () => {
	test('uses kotaete.ts schedule and questions from config', async () => {
		const quizDir = await writeQuizDir('w20260404', {
			'kotaete.ts': makeConfigKotaeteTs({
				messages: "  messages: { cooldownWarning: 'Tes cooldown {time}' },",
			}),
			'intro.md': 'intro',
		})

		const bundle = await loadQuizBundle(quizDir)
		expect(bundle.introAt.toISOString()).toBe(new Date('2026-04-04T07:50:00+07:00').toISOString())
		expect(bundle.startAt.toISOString()).toBe(new Date('2026-04-04T08:00:00+07:00').toISOString())
		expect(bundle.rounds).toHaveLength(1)
		expect(bundle.rounds[0]?.emoji).toBe('🌅')
		expect(bundle.messageTemplates.cooldownWarning).toBe('Tes cooldown {time}')

		// Verify question was sourced from config, not .md files
		expect(bundle.questions).toHaveLength(1)
		const q = bundle.questions[0]
		expect(q?.number).toBe(1)
		expect(q?.imagePath).toBeNull()
		expect(q?.answers).toContain('あ')
		expect(q?.answers).toContain('a')
		expect(q?.answers).toContain('亜')
		expect(q?.explanation).toBe('Hiragana a')
	})

	test('renders option block with all answer types present', async () => {
		const quizDir = await writeQuizDir('w20260404-opts', {
			'kotaete.ts': makeConfigKotaeteTs({
				questions: [
					'  questions: [',
					'    { no: 1, hint: "Soal tentang huruf A", answers: { kana: "あ", romaji: "a / hiragana", kanji: { text: "亜", extraPts: 2 } } },',
					'  ],',
				].join('\n'),
			}),
		})

		const bundle = await loadQuizBundle(quizDir)
		const q = bundle.questions[0]!
		expect(q.text).toContain('*Opsi jawab:*')
		expect(q.text).toContain('✅ かな (kana)')
		expect(q.text).toContain('✅ romaji + jenis kana')
		expect(q.text).toContain('🌸 漢字 (kanji) *+2pts*')
		expect(q.text).toContain('Soal tentang huruf A')
	})

	test('renders ❌ for missing answer types', async () => {
		const quizDir = await writeQuizDir('w20260404-missing', {
			'kotaete.ts': makeConfigKotaeteTs({
				questions: [
					'  questions: [',
					'    { no: 1, hint: "Missing types", answers: { romaji: "a / hiragana" } },',
					'  ],',
				].join('\n'),
			}),
		})

		const bundle = await loadQuizBundle(quizDir)
		const q = bundle.questions[0]!
		expect(q.text).toContain('❌ かな (kana)')
		expect(q.text).toContain('✅ romaji + jenis kana')
		expect(q.text).toContain('❌ 漢字 (kanji)')
		expect(q.text).not.toContain('🌸')
	})

	test('omits bonus marker when extraPts is missing or zero, shows when set', async () => {
		const quizDir = await writeQuizDir('w20260404-kanji-missing', {
			'kotaete.ts': [
				"import { defineConfig } from '@mdrv/kotaete'",
				'',
				'export default defineConfig({',
				"  intro: new Date('2026-04-04T07:50:00+07:00'),",
				'  rounds: [{ emoji: "🌅", start: new Date("2026-04-04T08:00:00+07:00"), questionRange: [1, 3] }],',
				'  questions: [',
				'    { no: 1, hint: "Missing", answers: { kana: "a", kanji: { text: "A" } } },',
				'    { no: 2, hint: "Zero", answers: { kana: "b", kanji: { text: "B", extraPts: 0 } } },',
				'    { no: 3, hint: "Set", answers: { kana: "c", kanji: { text: "C", extraPts: 3 } } },',
				'  ],',
				'})',
			].join('\n'),
		})

		const bundle = await loadQuizBundle(quizDir)
		const q1 = bundle.questions[0]!
		expect(q1.text).toContain('🌸 漢字 (kanji)')
		expect(q1.text).not.toContain('*+')

		const q2 = bundle.questions[1]!
		expect(q2.text).toContain('🌸 漢字 (kanji)')
		expect(q2.text).not.toContain('*+')

		const q3 = bundle.questions[2]!
		expect(q3.text).toContain('🌸 漢字 (kanji) *+3pts*')
	})

	test('throws when kotaete.ts is absent', async () => {
		const quizDir = await writeQuizDir('20260404-1450', {
			'01.md': 'Q1\n---\nabc\n',
			'intro.md': 'intro',
		})

		expect(loadQuizBundle(quizDir)).rejects.toThrow(`[quiz] missing kotaete.ts schedule config in "${quizDir}"`)
	})

	test('supports cascading sources and resolves groupId/members from merged config', async () => {
		const baseDir = await writeQuizDir('w20260404-cascade', {
			'kotaete.ts': [
				"import { defineConfig } from '@mdrv/kotaete'",
				'',
				'export default defineConfig({',
				"  intro: new Date('2026-04-04T07:50:00+07:00'),",
				"  groupId: '120@g.us',",
				"  template: '~/\.kotaete/template.svg',",
				'  rounds: [',
				'    { emoji: "🌅", start: new Date("2026-04-04T08:00:00+07:00"), questionRange: [1, 1] },',
				'  ],',
				'})',
			].join('\n'),
			'01.md': 'Q1\n---\nans\n',
		})

		const membersPath = join(sandboxDir, 'members-cascade.ts')
		await writeFile(
			membersPath,
			[
				"import { defineConfig } from '@mdrv/kotaete'",
				'',
				'export default defineConfig({',
				'  members: [',
				'    {',
				"      mid: 'm1',",
				"      kananame: 'かな',",
				"      nickname: 'nick',",
				"      classgroup: 'A',",
				"      number: '08123',",
				'    },',
				'  ],',
				'})',
			].join('\n'),
			'utf-8',
		)

		const overridePath = join(sandboxDir, 'override-cascade.ts')
		await writeFile(
			overridePath,
			[
				"import { defineConfig } from '@mdrv/kotaete'",
				'',
				'export default defineConfig({',
				"  groupId: '999@g.us',",
				'})',
			].join('\n'),
			'utf-8',
		)

		const bundle = await loadQuizBundle([membersPath, baseDir, overridePath])
		expect(bundle.groupId).toBe('999@g.us')
		expect(bundle.directory).toBe(baseDir)
		expect(bundle.members).toHaveLength(1)
		expect(bundle.membersFile).toBeNull()
		expect(bundle.sources).toHaveLength(3)
	})

	test('noSchedule forces immediate intro/start and reads from .md files', async () => {
		const quizDir = await writeQuizDir('w20260404-immediate', {
			'kotaete.ts': [
				"import { defineConfig } from '@mdrv/kotaete'",
				'',
				'export default defineConfig({',
				"  intro: new Date('2030-01-01T00:00:00+07:00'),",
				"  rounds: [{ emoji: '🌟', start: new Date('2030-01-01T00:10:00+07:00'), questionRange: [1, 1] }],",
				'})',
			].join('\n'),
			'01.md': 'Q1\n---\nabc\n',
		})

		const before = Date.now()
		const bundle = await loadQuizBundle(quizDir, { noSchedule: true })
		const after = Date.now()

		expect(bundle.introAt.getTime()).toBeGreaterThanOrEqual(before)
		expect(bundle.introAt.getTime()).toBeLessThanOrEqual(after)
		expect(bundle.startAt.getTime()).toBeGreaterThanOrEqual(before)
		expect(bundle.startAt.getTime()).toBeLessThanOrEqual(after)
		expect(bundle.rounds).toHaveLength(1)
		// noSchedule path reads from .md, not config questions
		expect(bundle.questions[0]?.text).toContain('Q1')
		// noSchedule now appends options block for formatting parity
		expect(bundle.questions[0]?.text).toContain('*Opsi jawab:*')
	})

	test('noSchedule strips *Hint:* and *Opsi jawab:* block from markdown question text', async () => {
		const quizDir = await writeQuizDir('w20260404-hint-prefix', {
			'kotaete.ts': [
				"import { defineConfig } from '@mdrv/kotaete'",
				'',
				'export default defineConfig({',
				"  intro: new Date('2030-01-01T00:00:00+07:00'),",
				"  rounds: [{ emoji: '🌟', start: new Date('2030-01-01T00:10:00+07:00'), questionRange: [1, 1] }],",
				'})',
			].join('\n'),
			'01.md': '*Hint:*\nWhat is あ?\n\n*Opsi jawab:*\n✅ かな (kana)\n---\nあ\n',
		})

		const bundle = await loadQuizBundle(quizDir, { noSchedule: true })
		expect(bundle.questions[0]?.text).toContain('What is あ?')
		expect(bundle.questions[0]?.text).not.toContain('Hint:')
		expect(bundle.questions[0]?.text.match(/Opsi jawab/g)?.length).toBe(1) // exactly once, since we stripped the hardcoded one
	})

	test('noSchedule infers kanji option from CJK answers and parses +N extra points', async () => {
		const quizDir = await writeQuizDir('w20260404-kanji-pts', {
			'kotaete.ts': [
				"import { defineConfig } from '@mdrv/kotaete'",
				'',
				'export default defineConfig({',
				"  intro: new Date('2030-01-01T00:00:00+07:00'),",
				"  rounds: [{ emoji: '🌟', start: new Date('2030-01-01T00:10:00+07:00'), questionRange: [1, 1] }],",
				'})',
			].join('\n'),
			'01.md': 'hint: What kanji?\n---\nあ\nromaji\n漢字 +2\n',
		})

		const bundle = await loadQuizBundle(quizDir, { noSchedule: true })
		expect(bundle.questions[0]?.text).toContain('🌸 漢字 (kanji) *+2pts*')
		expect(bundle.questions[0]?.text).toContain('✅ かな (kana)')
		expect(bundle.questions[0]?.text).toContain('✅ romaji + jenis kana')
		// Extra points marker stripped from answer text
		expect(bundle.questions[0]?.answers).toContain('漢字')
		expect(bundle.questions[0]?.answers).not.toContain('漢字 +2')
	})

	test('supports rounds-only config without start with config questions', async () => {
		const quizDir = await writeQuizDir('w20260404-rounds-only', {
			'kotaete.ts': [
				"import { defineConfig } from '@mdrv/kotaete'",
				'',
				'export default defineConfig({',
				"  intro: new Date('2026-04-04T07:50:00+07:00'),",
				'  rounds: [',
				'    { emoji: "🌅", start: new Date("2026-04-04T08:00:00+07:00"), questionRange: [1, 2] },',
				'    { emoji: "🌆", start: new Date("2026-04-04T15:00:00+07:00"), questionRange: [3, 3], godStage: 99 },',
				'  ],',
				'  questions: [',
				'    { no: 1, hint: "Q1", answers: { kana: "a1" } },',
				'    { no: 2, hint: "Q2", answers: { kana: "a2" } },',
				'    { no: 3, hint: "Q3", answers: { kana: "a3" } },',
				'    { no: 99, hint: "God", answers: { kana: "god" } },',
				'  ],',
				'})',
			].join('\n'),
		})

		const bundle = await loadQuizBundle(quizDir)
		expect(bundle.rounds).toHaveLength(2)
		expect(bundle.startAt.toISOString()).toBe(new Date('2026-04-04T08:00:00+07:00').toISOString())
		expect(bundle.rounds[0]?.questions.map((q) => q.number)).toEqual([1, 2])
		expect(bundle.rounds[1]?.questions.map((q) => q.number)).toEqual([3, 99])
		// Verify questions came from config (contain option block)
		expect(bundle.questions[0]?.text).toContain('*Opsi jawab:*')
	})

	test('throws when rounds contain duplicate question numbers', async () => {
		const quizDir = await writeQuizDir('w20260404-rounds-dup', {
			'kotaete.ts': [
				"import { defineConfig } from '@mdrv/kotaete'",
				'',
				'export default defineConfig({',
				"  intro: new Date('2026-04-04T07:50:00+07:00'),",
				'  rounds: [',
				'    { emoji: "🌅", start: new Date("2026-04-04T08:00:00+07:00"), questionRange: [1, 2] },',
				'    { emoji: "🌆", start: new Date("2026-04-04T15:00:00+07:00"), questionRange: [2, 3] },',
				'  ],',
				'  questions: [',
				'    { no: 1, hint: "Q1", answers: { kana: "a1" } },',
				'    { no: 2, hint: "Q2", answers: { kana: "a2" } },',
				'    { no: 3, hint: "Q3", answers: { kana: "a3" } },',
				'  ],',
				'})',
			].join('\n'),
		})

		expect(loadQuizBundle(quizDir)).rejects.toThrow('[quiz] duplicate question across rounds: 2')
	})

	test('throws when kotaete.ts does not import defineConfig from package', async () => {
		const quizDir = await writeQuizDir('w20260404-bad-config', {
			'kotaete.ts': [
				'export default {',
				"  intro: new Date('2026-04-04T07:50:00+07:00'),",
				"  start: new Date('2026-04-04T08:00:00+07:00'),",
				'}',
			].join('\n'),
		})

		expect(loadQuizBundle(quizDir)).rejects.toThrow(
			'[quiz] kotaete.ts must import defineConfig from "@mdrv/kotaete"',
		)
	})

	test('falls back to .md files when no questions in config', async () => {
		const quizDir = await writeQuizDir('w20260404-fallback', {
			'kotaete.ts': [
				"import { defineConfig } from '@mdrv/kotaete'",
				'',
				'export default defineConfig({',
				"  intro: new Date('2026-04-04T07:50:00+07:00'),",
				'  rounds: [',
				'    { emoji: "🌅", start: new Date("2026-04-04T08:00:00+07:00"), questionRange: [1, 1] },',
				'  ],',
				'})',
			].join('\n'),
			'01.md': 'Q1 from md\n---\nans\n',
		})

		const bundle = await loadQuizBundle(quizDir)
		expect(bundle.questions).toHaveLength(1)
		expect(bundle.questions[0]?.text).toContain('Q1 from md')
		expect(bundle.questions[0]?.text).toContain('*Opsi jawab:*')
	})

	test('noGeneration skips template rendering and uses existing question images', async () => {
		const quizDir = await writeQuizDir('w20260404-no-generation', {
			'kotaete.ts': [
				"import { defineConfig } from '@mdrv/kotaete'",
				'',
				'export default defineConfig({',
				"  intro: new Date('2026-04-04T07:50:00+07:00'),",
				'  rounds: [',
				'    { emoji: "🌅", start: new Date("2026-04-04T08:00:00+07:00"), questionRange: [1, 1] },',
				'  ],',
				'  questions: [',
				'    { no: 1, hint: "Q1", answers: { kana: "あ" }, image: { credit: "c", jp: "j", romaji: "r" } },',
				'  ],',
				'})',
			].join('\n'),
			'01.png': 'existing-image',
		})

		const bundle = await loadQuizBundle(quizDir, { noGeneration: true })
		expect(bundle.questions).toHaveLength(1)
		expect(bundle.questions[0]?.imagePath).toBe(join(quizDir, '01.png'))
	})

	test('noGeneration leaves imagePath null when no existing image is available', async () => {
		const quizDir = await writeQuizDir('w20260404-no-generation-missing', {
			'kotaete.ts': [
				"import { defineConfig } from '@mdrv/kotaete'",
				'',
				'export default defineConfig({',
				"  intro: new Date('2026-04-04T07:50:00+07:00'),",
				'  rounds: [',
				'    { emoji: "🌅", start: new Date("2026-04-04T08:00:00+07:00"), questionRange: [1, 1] },',
				'  ],',
				'  questions: [',
				'    { no: 1, hint: "Q1", answers: { kana: "あ" }, image: { credit: "c", jp: "j", romaji: "r" } },',
				'  ],',
				'})',
			].join('\n'),
		})

		const bundle = await loadQuizBundle(quizDir, { noGeneration: true })
		expect(bundle.questions[0]?.imagePath).toBeNull()
	})
})

describe('buildInkscapeArgs', () => {
	test('png export includes --export-type=png and --export-png-color-mode', () => {
		const args = buildInkscapeArgs('/out/01-ok.png', '/tmp/input.svg')
		expect(args[0]).toBe('inkscape')
		expect(args).toContain('--export-filename=/out/01-ok.png')
		expect(args).toContain('--export-type=png')
		expect(args).toContain('--export-png-color-mode=RGB_8')
		expect(args).toContain('--export-background=#ffffff')
		expect(args).toContain('--export-background-opacity=1')
		expect(args[args.length - 1]).toBe('/tmp/input.svg')
	})
})

describe('resolveImageExportPaths', () => {
	test('returns png/jpg paths and svgDestPath from bare stem', () => {
		const result = resolveImageExportPaths('/quiz/01-ok')
		expect(result.pngPath).toBe('/quiz/01-ok.png')
		expect(result.jpgPath).toBe('/quiz/01-ok.jpg')
		expect(result.svgDestPath).toBe('/quiz/01-ok.svg')
	})

	test('does not collapse stem when parent directory contains dots', () => {
		const result = resolveImageExportPaths('/home/ua/.kotaete/w20260404/01-ok')
		expect(result.pngPath).toBe('/home/ua/.kotaete/w20260404/01-ok.png')
		expect(result.jpgPath).toBe('/home/ua/.kotaete/w20260404/01-ok.jpg')
		expect(result.svgDestPath).toBe('/home/ua/.kotaete/w20260404/01-ok.svg')
	})

	test('normalizes input with existing extension into png/jpg/svg siblings', () => {
		const result = resolveImageExportPaths('/quiz/01-ok.png')
		expect(result.pngPath).toBe('/quiz/01-ok.png')
		expect(result.jpgPath).toBe('/quiz/01-ok.jpg')
		expect(result.svgDestPath).toBe('/quiz/01-ok.svg')
	})
})

describe('buildMagickJpgArgs', () => {
	test('builds png-to-jpg conversion args with quality 85', () => {
		const args = buildMagickJpgArgs('/out/01-ok.png', '/out/01-ok.jpg', 85)
		expect(args).toEqual(['magick', '/out/01-ok.png', '-quality', '85', '/out/01-ok.jpg'])
	})
})
