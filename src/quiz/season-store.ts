import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_STATE_DIR } from '../constants.ts'
import type { NMember } from '../types.ts'
import { expandHome } from '../utils/path.ts'

const DEFAULT_SEASON_STATE_PATH = `${DEFAULT_STATE_DIR}/season-points.json`

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

type SeasonPointsSnapshotV1 = {
	version: 1
	updatedAt: string
	groups: Record<
		string,
		{
			pointsByLid?: ReadonlyArray<{ lid: string; points: number }>
			pointsByPn?: ReadonlyArray<{ pn: string; points: number }>
			reachedAtByLid?: ReadonlyArray<{ lid: string; reachedAt: number }>
			members: ReadonlyArray<NMember>
		}
	>
}

type SeasonPointsSnapshotV2 = {
	version: 2
	updatedAt: string
	groups: Record<
		string,
		{
			pointsByMid: ReadonlyArray<{ mid: string; points: number }>
			reachedAtByMid: ReadonlyArray<{ mid: string; reachedAt: number }>
			members: ReadonlyArray<NMember>
		}
	>
}

type SeasonPointsSnapshot = SeasonPointsSnapshotV1 | SeasonPointsSnapshotV2

/**
 * Migrate a v1 (lid-keyed) snapshot entry into mid-keyed maps.
 * Falls back to pn if lid is not resolvable from the members list.
 */
function migrateV1ToMid(
	data: SeasonPointsSnapshotV1['groups'][string],
): { pointsByMid: Map<string, number>; reachedAtByMid: Map<string, number> } {
	const pointsByMid = new Map<string, number>()
	const reachedAtByMid = new Map<string, number>()
	const members = data.members ?? []

	// Build lid→mid and pn→mid lookup from members
	const lidToMid = new Map<string, string>()
	const pnToMid = new Map<string, string>()
	for (const m of members) {
		lidToMid.set(m.lid, m.mid)
		if (m.pn) pnToMid.set(m.pn, m.mid)
	}

	// Load pointsByLid (v1 primary)
	for (const entry of data.pointsByLid ?? []) {
		const mid = lidToMid.get(entry.lid) ?? entry.lid
		pointsByMid.set(mid, (pointsByMid.get(mid) ?? 0) + entry.points)
	}
	// Load pointsByPn (legacy)
	for (const entry of data.pointsByPn ?? []) {
		const mid = pnToMid.get(entry.pn) ?? entry.pn
		pointsByMid.set(mid, (pointsByMid.get(mid) ?? 0) + entry.points)
	}
	// Load reachedAtByLid
	for (const entry of data.reachedAtByLid ?? []) {
		const mid = lidToMid.get(entry.lid) ?? entry.lid
		if (!reachedAtByMid.has(mid)) {
			reachedAtByMid.set(mid, entry.reachedAt)
		}
	}

	return { pointsByMid, reachedAtByMid }
}

export class SeasonStore {
	private readonly statePath: string
	private groups = new Map<string, SeasonPointsState>()
	private saveChain = Promise.resolve()

	constructor(statePath?: string) {
		this.statePath = expandHome(statePath ?? DEFAULT_SEASON_STATE_PATH)
	}

	async load(): Promise<void> {
		let raw: string
		try {
			raw = await readFile(this.statePath, 'utf-8')
		} catch (error) {
			if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
				return
			}
			return
		}

		try {
			const parsed = JSON.parse(raw) as SeasonPointsSnapshot
			if (!parsed.groups || typeof parsed.groups !== 'object') return

			for (const [groupId, data] of Object.entries(parsed.groups)) {
				// Detect format per-group, not just by top-level version
				const groupData = data as SeasonPointsSnapshotV2['groups'][string] & SeasonPointsSnapshotV1['groups'][string]
				const isV1Group = 'pointsByLid' in groupData && groupData.pointsByLid !== undefined

				if (isV1Group) {
					// Migrate v1 → v2 format
					const { pointsByMid, reachedAtByMid } = migrateV1ToMid(data as SeasonPointsSnapshotV1['groups'][string])
					this.groups.set(groupId, {
						groupId,
						members: data.members ?? [],
						pointsByMid,
						reachedAtByMid,
					})
				} else {
					// V2: load directly
					const pointsByMid = new Map<string, number>()
					const reachedAtByMid = new Map<string, number>()
					for (const entry of groupData.pointsByMid ?? []) {
						pointsByMid.set(entry.mid, entry.points)
					}
					for (const entry of groupData.reachedAtByMid ?? []) {
						reachedAtByMid.set(entry.mid, entry.reachedAt)
					}
					this.groups.set(groupId, {
						groupId,
						members: groupData.members ?? [],
						pointsByMid,
						reachedAtByMid,
					})
				}
			}
		} catch {
			// Malformed — skip
		}
	}

	async persist(): Promise<void> {
		const snapshot: SeasonPointsSnapshotV2 = {
			version: 2,
			updatedAt: new Date().toISOString(),
			groups: {},
		}
		for (const [groupId, state] of this.groups.entries()) {
			snapshot.groups[groupId] = {
				pointsByMid: [...state.pointsByMid.entries()].map(([mid, points]) => ({ mid, points })),
				reachedAtByMid: [...state.reachedAtByMid.entries()].map(([mid, reachedAt]) => ({ mid, reachedAt })),
				members: state.members,
			}
		}
		const runSave = async () => {
			if (Object.keys(snapshot.groups).length === 0) {
				await unlink(this.statePath).catch(() => undefined)
				return
			}
			await mkdir(dirname(this.statePath), { recursive: true })
			const tmpPath = `${this.statePath}.${randomUUID()}.tmp`
			try {
				await writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8')
				await writeFile(this.statePath, await readFile(tmpPath, 'utf-8'), 'utf-8')
			} catch {
				// Ignore
			} finally {
				await unlink(tmpPath).catch(() => undefined)
			}
		}
		this.saveChain = this.saveChain.then(runSave, runSave)
		await this.saveChain
	}

	getPoints(groupId: string): Map<string, number> {
		return this.groups.get(groupId)?.pointsByMid ?? new Map()
	}

	getMembers(groupId: string): ReadonlyArray<NMember> {
		return this.groups.get(groupId)?.members ?? []
	}

	getReachedAt(groupId: string): Map<string, number> {
		return this.groups.get(groupId)?.reachedAtByMid ?? new Map()
	}

	async addPoints(
		groupId: string,
		members: ReadonlyArray<NMember>,
		pointsByMid: ReadonlyMap<string, number>,
	): Promise<void> {
		let state = this.groups.get(groupId)
		if (!state) {
			state = { groupId, members, pointsByMid: new Map(), reachedAtByMid: new Map() }
			this.groups.set(groupId, state)
		}
		const now = Date.now()
		for (const [mid, points] of pointsByMid.entries()) {
			const current = state.pointsByMid.get(mid) ?? 0
			state.pointsByMid.set(mid, current + points)
			if (points > 0) {
				state.reachedAtByMid.set(mid, now)
			}
		}
		await this.persist()
	}

	async resetGroup(groupId: string): Promise<void> {
		const state = this.groups.get(groupId)
		if (state) {
			state.pointsByMid.clear()
			state.reachedAtByMid.clear()
		}
		await this.persist()
	}

	async setGroupMembers(
		groupId: string,
		members: ReadonlyArray<NMember>,
	): Promise<void> {
		let state = this.groups.get(groupId)
		if (!state) {
			state = { groupId, members, pointsByMid: new Map(), reachedAtByMid: new Map() }
			this.groups.set(groupId, state)
		} else {
			state.members = members
		}
		await this.persist()
	}

	listGroups(): string[] {
		return [...this.groups.keys()]
	}

	async adjustPoints(groupId: string, memberMid: string, delta: number): Promise<void> {
		let state = this.groups.get(groupId)
		if (!state) {
			state = { groupId, members: [], pointsByMid: new Map(), reachedAtByMid: new Map() }
			this.groups.set(groupId, state)
		}
		const current = state.pointsByMid.get(memberMid) ?? 0
		state.pointsByMid.set(memberMid, current + delta)
		if (delta > 0) {
			state.reachedAtByMid.set(memberMid, Date.now())
		}
	}

	async setPoints(groupId: string, memberMid: string, points: number): Promise<void> {
		let state = this.groups.get(groupId)
		if (!state) {
			state = { groupId, members: [], pointsByMid: new Map(), reachedAtByMid: new Map() }
			this.groups.set(groupId, state)
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
		await this.persist()
	}
}
