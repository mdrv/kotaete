import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_STATE_DIR } from '../constants.ts'
import { expandHome } from '../utils/path.ts'

const DEFAULT_PLUGIN_STATE_PATH = `${DEFAULT_STATE_DIR}/plugins.json`

export type PluginManifestEntry = {
	name: string
	sourcePath: string
	args: Record<string, string>
	enabledAt: string
}

export type PluginManifestFile = {
	version: 1
	updatedAt: string
	plugins: PluginManifestEntry[]
}

export class PluginStore {
	private readonly filePath: string
	private manifest: PluginManifestFile | null = null

	constructor(filePath?: string) {
		this.filePath = expandHome(filePath ?? DEFAULT_PLUGIN_STATE_PATH)
	}

	async load(): Promise<void> {
		try {
			const raw = await readFile(this.filePath, 'utf-8')
			const parsed = JSON.parse(raw) as PluginManifestFile
			if (parsed.version !== 1) {
				throw new Error(`unsupported plugin manifest version: ${parsed.version}`)
			}
			this.manifest = parsed
		} catch (error) {
			if ((error as any).code === 'ENOENT') {
				this.manifest = { version: 1, updatedAt: new Date().toISOString(), plugins: [] }
				return
			}
			throw error
		}
	}

	get entries(): ReadonlyArray<PluginManifestEntry> {
		return this.manifest?.plugins ?? []
	}

	findByName(name: string): PluginManifestEntry | undefined {
		return this.manifest?.plugins.find((p) => p.name === name)
	}

	async add(entry: PluginManifestEntry): Promise<void> {
		if (!this.manifest) {
			this.manifest = { version: 1, updatedAt: new Date().toISOString(), plugins: [] }
		}
		// Remove existing entry with same name (reload scenario)
		this.manifest.plugins = this.manifest.plugins.filter((p) => p.name !== entry.name)
		this.manifest.plugins.push(entry)
		this.manifest.updatedAt = new Date().toISOString()
		await this.persist()
	}

	async remove(name: string): Promise<void> {
		if (!this.manifest) return
		this.manifest.plugins = this.manifest.plugins.filter((p) => p.name !== name)
		this.manifest.updatedAt = new Date().toISOString()
		await this.persist()
	}

	private async persist(): Promise<void> {
		if (!this.manifest) return
		const dir = dirname(this.filePath)
		await mkdir(dir, { recursive: true })
		const tmpPath = join(dir, `.plugins.tmp.${process.pid}`)
		await writeFile(tmpPath, JSON.stringify(this.manifest, null, '\t') + '\n', 'utf-8')
		await rename(tmpPath, this.filePath)
	}
}
