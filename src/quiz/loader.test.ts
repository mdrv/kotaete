import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, loadQuizBundle } from './loader.ts'

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

describe('defineConfig', () => {
	test('normalizes valid date-like values', () => {
		const config = defineConfig({
			intro: '2026-04-04T07:50:00+07:00',
			start: new Date('2026-04-04T08:00:00+07:00'),
		})

		expect(config.intro instanceof Date).toBe(true)
		expect(config.start instanceof Date).toBe(true)
		expect(Number.isNaN(config.intro.getTime())).toBe(false)
		expect(Number.isNaN(config.start.getTime())).toBe(false)
	})

	test('throws on invalid values', () => {
		expect(() => defineConfig({ intro: 'invalid-date', start: new Date() })).toThrow()
	})
})

describe('loadQuizBundle schedule behavior', () => {
	test('uses kotaete.ts schedule when present', async () => {
		const quizDir = await writeQuizDir('w20260404', {
			'kotaete.ts': [
				"import { defineConfig } from '@mdrv/kotaete'",
				'',
				'export default defineConfig({',
				"  intro: new Date('2026-04-04T07:50:00+07:00'),",
				"  start: new Date('2026-04-04T08:00:00+07:00'),",
				'})',
			].join('\n'),
			'01.md': 'Q1\n---\nabc\n',
			'intro.md': 'intro',
		})

		const bundle = await loadQuizBundle(quizDir)
		expect(bundle.introAt.toISOString()).toBe(new Date('2026-04-04T07:50:00+07:00').toISOString())
		expect(bundle.startAt.toISOString()).toBe(new Date('2026-04-04T08:00:00+07:00').toISOString())
	})

	test('throws when kotaete.ts is absent', async () => {
		const quizDir = await writeQuizDir('20260404-1450', {
			'01.md': 'Q1\n---\nabc\n',
			'intro.md': 'intro',
		})

		expect(loadQuizBundle(quizDir)).rejects.toThrow(`[quiz] missing kotaete.ts schedule config in "${quizDir}"`)
	})

	test('noSchedule forces immediate intro/start', async () => {
		const quizDir = await writeQuizDir('w20260404-immediate', {
			'kotaete.ts': [
				"import { defineConfig } from '@mdrv/kotaete'",
				'',
				'export default defineConfig({',
				"  intro: new Date('2030-01-01T00:00:00+07:00'),",
				"  start: new Date('2030-01-01T00:10:00+07:00'),",
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
	})

	test('throws when kotaete.ts does not import defineConfig from package', async () => {
		const quizDir = await writeQuizDir('w20260404-bad-config', {
			'kotaete.ts': [
				'export default {',
				"  intro: new Date('2026-04-04T07:50:00+07:00'),",
				"  start: new Date('2026-04-04T08:00:00+07:00'),",
				'}',
			].join('\n'),
			'01.md': 'Q1\n---\nabc\n',
		})

		expect(loadQuizBundle(quizDir)).rejects.toThrow(
			'[quiz] kotaete.ts must import defineConfig from "@mdrv/kotaete"',
		)
	})
})
