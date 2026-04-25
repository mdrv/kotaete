import { Surreal } from 'surrealdb'
import type { NMember } from '../types.ts'
import type { SurrealOptions } from '../utils/surreal.ts'
import { getDb } from '../utils/surreal.ts'

export type SeasonPointsEntry = {
	mid: string
	points: number
}

export type SeasonPointsState = {
	groupId: string
	members: ReadonlyArray<NMember>
	pointsByMid: Map<string, number>
	reachedAtByMid: Map<string, number>
}

/**
 * Minimal interface for season score storage.
 * Both SeasonStore (SurrealDB-backed) and InMemorySeasonStore implement this.
 */
export interface SeasonStoreLike {
	load(): Promise<void>
	persist(): Promise<void>
	getPoints(key: string): Map<string, number>
	getPointsAsync(key: string, seasonId?: string): Promise<Map<string, number>>
	getMembers(key: string): ReadonlyArray<NMember>
	getMembersAsync(key: string, seasonId?: string): Promise<ReadonlyArray<NMember>>
	getReachedAt(key: string): Map<string, number>
	getReachedAtAsync(key: string, seasonId?: string): Promise<Map<string, number>>
	addPoints(
		key: string,
		members: ReadonlyArray<NMember>,
		pointsByMid: ReadonlyMap<string, number>,
		seasonId?: string,
	): Promise<void>
	resetGroup(key: string, seasonId?: string): Promise<void>
	setGroupMembers(key: string, members: ReadonlyArray<NMember>, seasonId?: string): Promise<void>
	listGroups(): string[]
	adjustPoints(key: string, memberMid: string, delta: number, seasonId?: string): Promise<void>
	setPoints(key: string, memberMid: string, points: number, seasonId?: string): Promise<void>
	clearAll(): Promise<void>
}

export type SeasonStoreOptions = SurrealOptions

const SCHEMA_QUERIES = [
	`DEFINE TABLE OVERWRITE season SCHEMAFULL`,
	`DEFINE FIELD OVERWRITE season_id ON season TYPE string`,
	`DEFINE FIELD OVERWRITE group_id ON season TYPE string`,
	`DEFINE FIELD OVERWRITE caption ON season TYPE option<string>`,
	`DEFINE FIELD OVERWRITE status ON season TYPE string DEFAULT 'active'`,
	`DEFINE FIELD OVERWRITE created_at ON season TYPE datetime DEFAULT time::now()`,
	`DEFINE FIELD OVERWRITE updated_at ON season TYPE datetime DEFAULT time::now()`,
	`DEFINE INDEX OVERWRITE season_id_unique ON season COLUMNS season_id UNIQUE`,
	`DEFINE TABLE OVERWRITE season_score SCHEMAFULL`,
	`DEFINE FIELD OVERWRITE season_id ON season_score TYPE string`,
	`DEFINE FIELD OVERWRITE mid ON season_score TYPE string`,
	`DEFINE FIELD OVERWRITE points ON season_score TYPE number DEFAULT 0`,
	`DEFINE FIELD OVERWRITE reached_at ON season_score TYPE option<number>`,
	`DEFINE FIELD OVERWRITE nickname ON season_score TYPE string`,
	`DEFINE FIELD OVERWRITE kananame ON season_score TYPE string`,
	`DEFINE FIELD OVERWRITE classgroup ON season_score TYPE string`,
	`DEFINE INDEX OVERWRITE season_score_unique ON season_score COLUMNS season_id, mid UNIQUE`,
] as const

type ScoreRow = {
	mid: string
	points: number
	reached_at?: number | null
	nickname: string
	kananame: string
	classgroup: string
}

export class SeasonStore {
	private db: Surreal | null = null
	private readonly options: SeasonStoreOptions
	private seasonCache = new Map<string, string>() // groupId → seasonId
	private queryChain = Promise.resolve()

	constructor(optionsOrPath?: SeasonStoreOptions | string) {
		if (typeof optionsOrPath === 'string') {
			// Backward compat: old API accepted a statePath string — ignore it
			this.options = {}
		} else {
			this.options = { ...optionsOrPath }
		}
	}

	private ensureDb(): Surreal {
		if (!this.db) throw new Error('SeasonStore not loaded — call load() first')
		return this.db
	}

	async load(): Promise<void> {
		const db: Surreal = await getDb(this.options)

		// Ensure schema
		for (const q of SCHEMA_QUERIES) {
			await db.query(q)
		}

		// Warm season cache: load all active seasons
		const seasons = await db.query<[Array<{ season_id: string; group_id: string }>]>(
			`SELECT season_id, group_id FROM season WHERE status = 'active'`,
		)
		for (const row of seasons[0] ?? []) {
			this.seasonCache.set(row.group_id, row.season_id)
		}

		this.db = db
	}

	async persist(): Promise<void> {
		// No-op: SurrealDB persists automatically
	}

	private async resolveSeasonId(key: string): Promise<string | undefined> {
		const cached = this.seasonCache.get(key)
		if (cached) return cached

		const db = this.ensureDb()
		const results = await db.query<[Array<{ season_id: string }>]>(
			`SELECT season_id FROM season WHERE group_id = $gid AND status = 'active' LIMIT 1`,
			{ gid: key },
		)
		const sid = results[0]?.[0]?.season_id
		if (sid) {
			this.seasonCache.set(key, sid)
		}
		return sid
	}

	private async resolveOrCreateSeasonId(key: string): Promise<string> {
		const existing = await this.resolveSeasonId(key)
		if (existing) return existing

		const db = this.ensureDb()
		const sid = key // use groupId as seasonId for backward compat
		await db.query(
			`CREATE season SET season_id = $sid, group_id = $gid, status = 'active'`,
			{ sid, gid: key },
		)
		this.seasonCache.set(key, sid)
		return sid
	}

	private chain(fn: () => Promise<void>): Promise<void> {
		const run = async () => {
			await fn()
		}
		this.queryChain = this.queryChain.then(run, run)
		return this.queryChain
	}

	getPoints(key: string): Map<string, number> {
		// Sync access not possible with SurrealDB — return empty Map
		return new Map()
	}

	async getPointsAsync(key: string, seasonId?: string): Promise<Map<string, number>> {
		const db = this.ensureDb()
		const sid = seasonId ?? (await this.resolveSeasonId(key))
		if (!sid) return new Map()

		const results = await db.query<[Array<ScoreRow>]>(
			`SELECT mid, points FROM season_score WHERE season_id = $sid`,
			{ sid },
		)
		const map = new Map<string, number>()
		for (const row of results[0] ?? []) {
			if (row.points > 0) {
				map.set(row.mid, row.points)
			}
		}
		return map
	}

	getMembers(key: string): ReadonlyArray<NMember> {
		return []
	}

	async getMembersAsync(key: string, seasonId?: string): Promise<ReadonlyArray<NMember>> {
		const db = this.ensureDb()
		const sid = seasonId ?? (await this.resolveSeasonId(key))
		if (!sid) return []

		const results = await db.query<[Array<ScoreRow>]>(
			`SELECT mid, nickname, kananame, classgroup FROM season_score WHERE season_id = $sid`,
			{ sid },
		)

		return (results[0] ?? []).map((row): NMember => ({
			mid: row.mid,
			nickname: row.nickname ?? '',
			kananame: row.kananame ?? '',
			classgroup: row.classgroup ?? '',
			lid: '',
		}))
	}

	getReachedAt(key: string): Map<string, number> {
		return new Map()
	}

	async getReachedAtAsync(key: string, seasonId?: string): Promise<Map<string, number>> {
		const db = this.ensureDb()
		const sid = seasonId ?? (await this.resolveSeasonId(key))
		if (!sid) return new Map()

		const results = await db.query<[Array<{ mid: string; reached_at: number | null }>]>(
			`SELECT mid, reached_at FROM season_score WHERE season_id = $sid`,
			{ sid },
		)
		const map = new Map<string, number>()
		for (const row of results[0] ?? []) {
			if (row.reached_at != null) {
				map.set(row.mid, row.reached_at)
			}
		}
		return map
	}

	async addPoints(
		key: string,
		members: ReadonlyArray<NMember>,
		pointsByMid: ReadonlyMap<string, number>,
		seasonId?: string,
	): Promise<void> {
		const db = this.ensureDb()
		const sid = seasonId ?? (await this.resolveOrCreateSeasonId(key))
		const now = Date.now()
		const memberMap = new Map(members.map((m) => [m.mid, m]))

		return this.chain(async () => {
			for (const [mid, points] of pointsByMid.entries()) {
				const member = memberMap.get(mid)
				const nickname = member?.nickname ?? ''
				const kananame = member?.kananame ?? ''
				const classgroup = member?.classgroup ?? ''

				if (points > 0) {
					// Use SurrealQL for atomic upsert
					await db.query(
						`LET $existing = (SELECT points FROM season_score WHERE season_id = $sid AND mid = $mid LIMIT 1);
						LET $current = $existing[0].points ?? 0;
						IF $existing = [] {
							CREATE season_score SET season_id = $sid, mid = $mid, points = $delta, reached_at = $now, nickname = $nickname, kananame = $kananame, classgroup = $classgroup;
						} ELSE {
							UPDATE season_score SET points = ($current + $delta), reached_at = $now, nickname = $nickname, kananame = $kananame, classgroup = $classgroup WHERE season_id = $sid AND mid = $mid;
						}`,
						{ sid, mid, delta: points, now, nickname, kananame, classgroup },
					)
				}
			}
		})
	}

	async resetGroup(key: string, seasonId?: string): Promise<void> {
		const db = this.ensureDb()
		const sid = seasonId ?? (await this.resolveSeasonId(key))
		if (!sid) return

		return this.chain(async () => {
			await db.query(`DELETE FROM season_score WHERE season_id = $sid`, { sid })
			await db.query(`UPDATE season SET updated_at = time::now() WHERE season_id = $sid`, { sid })
		})
	}

	async setGroupMembers(
		key: string,
		members: ReadonlyArray<NMember>,
		seasonId?: string,
	): Promise<void> {
		const db = this.ensureDb()
		const sid = seasonId ?? (await this.resolveOrCreateSeasonId(key))

		return this.chain(async () => {
			// Ensure season record exists — use upsert via LET/IF
			await db.query(
				`LET $existing = (SELECT id FROM season WHERE season_id = $sid LIMIT 1);
				IF $existing = [] {
					CREATE season SET season_id = $sid, group_id = $gid, status = 'active';
				} ELSE {
					UPDATE season SET group_id = $gid, updated_at = time::now() WHERE season_id = $sid;
				}`,
				{ sid, gid: key },
			)

			// Ensure score records exist for all members
			for (const m of members) {
				await db.query(
					`LET $has = (SELECT id FROM season_score WHERE season_id = $sid AND mid = $mid LIMIT 1);
					IF $has = [] {
						CREATE season_score SET season_id = $sid, mid = $mid, points = 0, nickname = $nickname, kananame = $kananame, classgroup = $classgroup;
					} ELSE {
						UPDATE season_score MERGE { nickname: $nickname, kananame: $kananame, classgroup: $classgroup } WHERE season_id = $sid AND mid = $mid;
					}`,
					{ sid, mid: m.mid, nickname: m.nickname, kananame: m.kananame, classgroup: m.classgroup },
				)
			}
		})
	}

	listGroups(): string[] {
		return [...this.seasonCache.keys()]
	}

	async listGroupsAsync(): Promise<string[]> {
		const db = this.ensureDb()
		const results = await db.query<[Array<{ group_id: string }>]>(
			`SELECT group_id FROM season GROUP BY group_id`,
		)
		const groups = [...new Set((results[0] ?? []).map((r) => r.group_id))]
		for (const g of groups) {
			if (!this.seasonCache.has(g)) {
				const active = await db.query<[Array<{ season_id: string }>]>(
					`SELECT season_id FROM season WHERE group_id = $gid AND status = 'active' LIMIT 1`,
					{ gid: g },
				)
				if (active[0]?.[0]?.season_id) {
					this.seasonCache.set(g, active[0][0].season_id)
				}
			}
		}
		return groups
	}

	async adjustPoints(key: string, memberMid: string, delta: number, seasonId?: string): Promise<void> {
		const db = this.ensureDb()
		const sid = seasonId ?? (await this.resolveOrCreateSeasonId(key))

		return this.chain(async () => {
			const now = delta > 0 ? Date.now() : undefined

			await db.query(
				`LET $existing = (SELECT points FROM season_score WHERE season_id = $sid AND mid = $mid LIMIT 1);
				LET $current = $existing[0].points ?? 0;
				LET $new = ($current + $delta);
				IF $new <= 0 {
					DELETE FROM season_score WHERE season_id = $sid AND mid = $mid;
				} ELSE IF $existing = [] {
					CREATE season_score SET season_id = $sid, mid = $mid, points = $new, reached_at = $now, nickname = '', kananame = '', classgroup = '';
				} ELSE {
					UPDATE season_score SET points = $new, reached_at = $now WHERE season_id = $sid AND mid = $mid;
				}`,
				{ sid, mid: memberMid, delta, now },
			)
		})
	}

	async setPoints(key: string, memberMid: string, points: number, seasonId?: string): Promise<void> {
		const db = this.ensureDb()
		const sid = seasonId ?? (await this.resolveOrCreateSeasonId(key))

		return this.chain(async () => {
			if (points <= 0) {
				await db.query(`DELETE FROM season_score WHERE season_id = $sid AND mid = $mid`, {
					sid,
					mid: memberMid,
				})
				return
			}

			const now = Date.now()

			await db.query(
				`LET $existing = (SELECT id FROM season_score WHERE season_id = $sid AND mid = $mid LIMIT 1);
				IF $existing = [] {
					CREATE season_score SET season_id = $sid, mid = $mid, points = $points, reached_at = $now, nickname = '', kananame = '', classgroup = '';
				} ELSE {
					UPDATE season_score SET points = $points, reached_at = $now WHERE season_id = $sid AND mid = $mid;
				}`,
				{ sid, mid: memberMid, points, now },
			)
		})
	}

	async clearAll(): Promise<void> {
		const db = this.ensureDb()
		await db.query(`DELETE FROM season_score`)
		await db.query(`DELETE FROM season`)
		this.seasonCache.clear()
	}
}

/**
 * In-memory SeasonStore for testing. No SurrealDB connection needed.
 * Supports the same API as SeasonStore but stores data in Maps.
 */
export class InMemorySeasonStore {
	private groups = new Map<string, SeasonPointsState>()

	async load(): Promise<void> {
		// No-op
	}

	async persist(): Promise<void> {
		// No-op
	}

	getPoints(key: string): Map<string, number> {
		return this.groups.get(key)?.pointsByMid ?? new Map()
	}

	async getPointsAsync(key: string, _seasonId?: string): Promise<Map<string, number>> {
		return this.getPoints(key)
	}

	getMembers(key: string): ReadonlyArray<NMember> {
		return this.groups.get(key)?.members ?? []
	}

	async getMembersAsync(key: string, _seasonId?: string): Promise<ReadonlyArray<NMember>> {
		return this.getMembers(key)
	}

	getReachedAt(key: string): Map<string, number> {
		return this.groups.get(key)?.reachedAtByMid ?? new Map()
	}

	async getReachedAtAsync(key: string, _seasonId?: string): Promise<Map<string, number>> {
		return this.getReachedAt(key)
	}

	async addPoints(
		key: string,
		members: ReadonlyArray<NMember>,
		pointsByMid: ReadonlyMap<string, number>,
		_seasonId?: string,
	): Promise<void> {
		let state = this.groups.get(key)
		if (!state) {
			state = { groupId: key, members, pointsByMid: new Map(), reachedAtByMid: new Map() }
			this.groups.set(key, state)
		}
		const now = Date.now()
		for (const [mid, points] of pointsByMid.entries()) {
			const current = state.pointsByMid.get(mid) ?? 0
			state.pointsByMid.set(mid, current + points)
			if (points > 0) {
				state.reachedAtByMid.set(mid, now)
			}
		}
	}

	async resetGroup(key: string, _seasonId?: string): Promise<void> {
		const state = this.groups.get(key)
		if (state) {
			state.pointsByMid.clear()
			state.reachedAtByMid.clear()
		}
	}

	async setGroupMembers(
		key: string,
		members: ReadonlyArray<NMember>,
		_seasonId?: string,
	): Promise<void> {
		let state = this.groups.get(key)
		if (!state) {
			state = { groupId: key, members, pointsByMid: new Map(), reachedAtByMid: new Map() }
			this.groups.set(key, state)
		} else {
			state.members = members
		}
	}

	listGroups(): string[] {
		return [...this.groups.keys()]
	}

	async adjustPoints(key: string, memberMid: string, delta: number, _seasonId?: string): Promise<void> {
		let state = this.groups.get(key)
		if (!state) {
			state = { groupId: key, members: [], pointsByMid: new Map(), reachedAtByMid: new Map() }
			this.groups.set(key, state)
		}
		const current = state.pointsByMid.get(memberMid) ?? 0
		state.pointsByMid.set(memberMid, current + delta)
		if (delta > 0) {
			state.reachedAtByMid.set(memberMid, Date.now())
		}
	}

	async setPoints(key: string, memberMid: string, points: number, _seasonId?: string): Promise<void> {
		let state = this.groups.get(key)
		if (!state) {
			state = { groupId: key, members: [], pointsByMid: new Map(), reachedAtByMid: new Map() }
			this.groups.set(key, state)
		}
		if (points <= 0) {
			state.pointsByMid.delete(memberMid)
			state.reachedAtByMid.delete(memberMid)
		} else {
			state.pointsByMid.set(memberMid, points)
			state.reachedAtByMid.set(memberMid, Date.now())
		}
	}

	async clearAll(): Promise<void> {
		this.groups.clear()
	}
}
