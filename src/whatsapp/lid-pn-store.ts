import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_LID_PN_MAP_PATH } from '../constants.ts'
import { getLogger } from '../logger.ts'
import { normalizeJidNumber } from '../utils/normalize.ts'
import { expandHome } from '../utils/path.ts'

const log = getLogger(['kotaete', 'wa', 'mapping'])

type MappingPayload = {
	version: 1
	updatedAt: string
	entries: Record<string, string>
}

const MAX_ENTRIES = 10_000

function normalizeLid(lid: string): string | null {
	const raw = lid.trim().replace(/^whatsapp:/, '')
	if (!raw) return null
	const [userPart] = raw.split('@')
	const user = (userPart ?? '').split(':')[0]?.trim() ?? ''
	if (!user) return null
	return user
}

export class LidPnStore {
	private readonly map = new Map<string, string>()
	private loaded = false
	private readonly filePath: string

	constructor(pathLike: string = DEFAULT_LID_PN_MAP_PATH) {
		this.filePath = expandHome(pathLike)
	}

	async load(): Promise<void> {
		if (this.loaded) return
		this.loaded = true
		this.map.clear()

		try {
			const raw = await readFile(this.filePath, 'utf-8')
			const parsed = JSON.parse(raw) as Partial<MappingPayload>
			const entries = parsed.entries
			if (!entries || typeof entries !== 'object') return

			for (const [lidRaw, pnRaw] of Object.entries(entries)) {
				const lid = normalizeLid(lidRaw)
				if (!lid) continue
				const pn = normalizeJidNumber(String(pnRaw))
				if (!pn) continue
				this.map.set(lid, pn)
			}

			if (this.map.size > MAX_ENTRIES) {
				const keep = [...this.map.entries()].slice(-MAX_ENTRIES)
				this.map.clear()
				for (const [lid, pn] of keep) this.map.set(lid, pn)
			}
		} catch (error) {
			if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT') return
			log.warning(`failed reading lid->pn map: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	get(lidRaw: string): string | null {
		const lid = normalizeLid(lidRaw)
		if (!lid) return null
		return this.map.get(lid) ?? null
	}

	entriesCount(): number {
		return this.map.size
	}

	async set(lidRaw: string, pnRaw: string): Promise<boolean> {
		await this.load()
		const lid = normalizeLid(lidRaw)
		const pn = normalizeJidNumber(pnRaw)
		if (!lid || !pn) return false

		const before = this.map.get(lid)
		if (before === pn) return false
		this.map.set(lid, pn)
		if (this.map.size > MAX_ENTRIES) {
			const firstKey = this.map.keys().next().value
			if (firstKey) this.map.delete(firstKey)
		}
		await this.save()
		return true
	}

	private async save(): Promise<void> {
		const payload: MappingPayload = {
			version: 1,
			updatedAt: new Date().toISOString(),
			entries: Object.fromEntries(this.map),
		}

		await mkdir(dirname(this.filePath), { recursive: true })
		const tmpPath = `${this.filePath}.tmp`
		await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
		await rename(tmpPath, this.filePath)
	}
}

export const __lidPnStoreTestInternals = {
	normalizeLid,
}
