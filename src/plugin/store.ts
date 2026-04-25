import { Surreal } from 'surrealdb'
import type { SurrealOptions } from '../utils/surreal.ts'
import { getDb } from '../utils/surreal.ts'

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

type PluginManifestRow = {
	name: string
	source_path: string
	args?: Record<string, string>
	enabled_at: string | Date
}

const SCHEMA_QUERIES = [
	`DEFINE TABLE OVERWRITE plugin_manifest SCHEMAFULL`,
	`DEFINE FIELD OVERWRITE name ON plugin_manifest TYPE string`,
	`DEFINE FIELD OVERWRITE source_path ON plugin_manifest TYPE string`,
	`DEFINE FIELD OVERWRITE args ON plugin_manifest TYPE object FLEXIBLE`,
	`DEFINE FIELD OVERWRITE enabled_at ON plugin_manifest TYPE datetime`,
	`DEFINE FIELD OVERWRITE updated_at ON plugin_manifest TYPE datetime DEFAULT time::now()`,
	`DEFINE INDEX OVERWRITE plugin_manifest_name_unique ON plugin_manifest COLUMNS name UNIQUE`,
] as const

const inMemoryManifests = new Map<string, PluginManifestFile>()

export class PluginStore {
	private readonly memoryNamespace: string | null
	private readonly options: SurrealOptions
	private db: Surreal | null = null
	private manifest: PluginManifestFile | null = null
	private queryChain = Promise.resolve()

	constructor(optionsOrNamespace?: SurrealOptions | string) {
		if (typeof optionsOrNamespace === 'string') {
			this.memoryNamespace = optionsOrNamespace
			this.options = {}
			return
		}
		this.memoryNamespace = null
		this.options = optionsOrNamespace ?? {}
	}

	private ensureDb(): Surreal {
		if (!this.db) throw new Error('PluginStore not initialized')
		return this.db
	}

	private chain(fn: () => Promise<void>): Promise<void> {
		const run = async () => {
			await fn()
		}
		this.queryChain = this.queryChain.then(run, run)
		return this.queryChain
	}

	async load(): Promise<void> {
		if (this.memoryNamespace) {
			const existing = inMemoryManifests.get(this.memoryNamespace)
			this.manifest = existing
				? structuredClone(existing)
				: { version: 1, updatedAt: new Date().toISOString(), plugins: [] }
			return
		}

		const db = await getDb(this.options)
		for (const q of SCHEMA_QUERIES) {
			await db.query(q)
		}
		this.db = db

		const rows = await db.query<[PluginManifestRow[]]>(
			`SELECT name, source_path, args, enabled_at FROM plugin_manifest ORDER BY enabled_at ASC`,
		)
		const plugins = (rows[0] ?? []).map((row) => ({
			name: row.name,
			sourcePath: row.source_path,
			args: row.args ?? {},
			enabledAt: row.enabled_at instanceof Date ? row.enabled_at.toISOString() : String(row.enabled_at),
		}))
		this.manifest = {
			version: 1,
			updatedAt: new Date().toISOString(),
			plugins,
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
		this.manifest.plugins.sort((a, b) => a.enabledAt.localeCompare(b.enabledAt))
		this.manifest.updatedAt = new Date().toISOString()

		if (this.memoryNamespace) {
			inMemoryManifests.set(this.memoryNamespace, structuredClone(this.manifest))
			return
		}

		const db = this.ensureDb()
		await this.chain(async () => {
			await db.query(
				`LET $existing = (SELECT id FROM plugin_manifest WHERE name = $name LIMIT 1);
				IF $existing = [] {
					CREATE plugin_manifest SET
						name = $name,
						source_path = $sourcePath,
						args = $args,
						enabled_at = <datetime>$enabledAt,
						updated_at = time::now();
				} ELSE {
					UPDATE plugin_manifest SET
						source_path = $sourcePath,
						args = $args,
						enabled_at = <datetime>$enabledAt,
						updated_at = time::now()
					WHERE name = $name;
				}`,
				{
					name: entry.name,
					sourcePath: entry.sourcePath,
					args: entry.args,
					enabledAt: entry.enabledAt,
				},
			)
		})
	}

	async remove(name: string): Promise<void> {
		if (!this.manifest) return
		this.manifest.plugins = this.manifest.plugins.filter((p) => p.name !== name)
		this.manifest.updatedAt = new Date().toISOString()

		if (this.memoryNamespace) {
			inMemoryManifests.set(this.memoryNamespace, structuredClone(this.manifest))
			return
		}

		const db = this.ensureDb()
		await this.chain(async () => {
			await db.query(`DELETE FROM plugin_manifest WHERE name = $name`, { name })
		})
	}
}
