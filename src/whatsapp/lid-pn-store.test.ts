import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __lidPnStoreTestInternals, LidPnStore } from './lid-pn-store.ts'

const dirs: string[] = []

afterEach(async () => {
	while (dirs.length > 0) {
		const dir = dirs.pop()
		if (!dir) continue
		await rm(dir, { recursive: true, force: true })
	}
})

async function makeFilePath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'kotaete-lidpn-'))
	dirs.push(dir)
	return join(dir, 'lid-pn-map.json')
}

describe('LidPnStore', () => {
	test('normalizeLid extracts normalized user part', () => {
		expect(__lidPnStoreTestInternals.normalizeLid('200729742577712@lid')).toBe('200729742577712')
		expect(__lidPnStoreTestInternals.normalizeLid('whatsapp:200729742577712:3@lid')).toBe('200729742577712')
		expect(__lidPnStoreTestInternals.normalizeLid('')).toBeNull()
	})

	test('set persists mapping and load restores it', async () => {
		const filePath = await makeFilePath()
		const storeA = new LidPnStore(filePath)
		await storeA.load()
		await storeA.set('200729742577712@lid', '628123456789@c.us')

		const raw = await readFile(filePath, 'utf-8')
		expect(raw).toContain('200729742577712')
		expect(raw).toContain('628123456789')

		const storeB = new LidPnStore(filePath)
		await storeB.load()
		expect(storeB.get('200729742577712@lid')).toBe('628123456789')
		expect(storeB.entriesCount()).toBe(1)
	})

	test('set no-op when mapping unchanged', async () => {
		const filePath = await makeFilePath()
		const store = new LidPnStore(filePath)
		await store.load()

		expect(await store.set('200729742577712@lid', '628123456789')).toBe(true)
		expect(await store.set('200729742577712@lid', '628123456789')).toBe(false)
	})
})
