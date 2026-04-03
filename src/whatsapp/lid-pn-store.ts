import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
	private saveChain = Promise.resolve()

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

	getLidByPn(pnRaw: string): string | null {
		const pn = normalizeJidNumber(pnRaw)
		if (!pn) return null
		const entries = Array.from(this.map.entries())
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const [lid, mappedPn] = entries[i]!
			if (mappedPn === pn) return `${lid}@lid`
		}
		return null
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

		// Serialize concurrent saves via promise chain
		const runSave = async () => {
			await mkdir(dirname(this.filePath), { recursive: true })
			const tmpPath = join(dirname(this.filePath), `lid-pn-map-${randomUUID()}.tmp`)
			try {
				await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
				await rename(tmpPath, this.filePath)
			} catch (error) {
				try {
					await unlink(tmpPath)
				} catch { /* ignore cleanup failure */ }
				log.warning(`failed saving lid->pn map: ${error instanceof Error ? error.message : String(error)}`)
			}
		}

		this.saveChain = this.saveChain.then(runSave, runSave)
		await this.saveChain
	}
}

export const __lidPnStoreTestInternals = {
	normalizeLid,
}
