import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LidPnStore } from '../../whatsapp/lid-pn-store.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

const dirs: string[] = []

afterEach(async () => {
	while (dirs.length > 0) {
		const dir = dirs.pop()
		if (!dir) continue
		await rm(dir, { recursive: true, force: true })
	}
})

async function makeStore(): Promise<LidPnStore> {
	const dir = await mkdtemp(join(tmpdir(), 'kotaete-tool-test-'))
	dirs.push(dir)
	const store = new LidPnStore(join(dir, 'lid-pn-map.json'))
	await store.load()
	return store
}

describe('LidPnStore reverse lookup for tool commands', () => {
	test('getLidByPn finds lid from PN JID', async () => {
		const store = await makeStore()
		await store.set('200729742577712@lid', '628123456789@s.whatsapp.net')

		expect(store.getLidByPn('628123456789@s.whatsapp.net')).toBe('200729742577712@lid')
		expect(store.getLidByPn('+62 812-3456-789')).toBe('200729742577712@lid')
	})

	test('getLidByPn returns most recent mapping when PN moved', async () => {
		const store = await makeStore()
		await store.set('111@lid', '628123456789@s.whatsapp.net')
		await store.set('222@lid', '628123456789@s.whatsapp.net')

		expect(store.getLidByPn('628123456789')).toBe('222@lid')
	})

	test('getLidByPn returns null for unknown input', async () => {
		const store = await makeStore()
		await store.set('200729742577712@lid', '628123456789@s.whatsapp.net')

		expect(store.getLidByPn('')).toBeNull()
		expect(store.getLidByPn('628000000000')).toBeNull()
	})
})

describe('CLI registration paths', () => {
	test('quiz run subcommand exists in quiz.ts imports', async () => {
		// Verify quiz.ts imports and uses createRunHandler from run.ts
		const quizModulePath = resolve(__dirname, 'quiz.ts')
		const quizSource = Bun.file(quizModulePath)
		const text = await quizSource.text()
		expect(text).toContain('createRunHandler')
		expect(text).toContain(".sub('run')")
	})

	test('top-level run command removed from CLI index', async () => {
		const indexPath = resolve(__dirname, '..', 'index.ts')
		const indexSource = Bun.file(indexPath)
		const text = await indexSource.text()
		expect(text).not.toContain('runCmd')
		expect(text).not.toContain("from './commands/run.ts'")
	})
})
