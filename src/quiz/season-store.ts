import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_STATE_DIR } from '../constants.ts'
import type { NMember } from '../types.ts'
import { expandHome } from '../utils/path.ts'

const DEFAULT_SEASON_STATE_PATH = `${DEFAULT_STATE_DIR}/season-points.json`

export type SeasonPointsEntry = {
	lid: string
	points: number
	pn?: string
}

export type SeasonPointsState = {
	groupId: string
	members: ReadonlyArray<NMember>
	pointsByLid: Map<string, number>
	reachedAtByLid: Map<string, number>
}

type SeasonPointsSnapshot = {
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

/** Detect legacy (PN-keyed) vs new (LID-keyed) snapshot shape. */
function isLegacySnapshot(parsed: Record<string, unknown>): boolean {
	const groups = parsed.groups
	if (!groups || typeof groups !== 'object') return false
	for (const data of Object.values(groups) as Array<Record<string, unknown>>) {
		const points = data.pointsByPn as Array<{ pn?: string; lid?: string }> | undefined
		if (points && points.length > 0) {
			const first = points[0]
			if (first && typeof first.pn === 'string' && typeof first.lid !== 'string') {
				return true
			}
		}
	}
	return false
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

			// Detect legacy PN-keyed format
			const legacy = isLegacySnapshot(parsed as unknown as Record<string, unknown>)

			for (const [groupId, data] of Object.entries(parsed.groups)) {
				const pointsByLid = new Map<string, number>()
				const reachedAtByLid = new Map<string, number>()
				for (const entry of data.pointsByLid ?? []) {
					pointsByLid.set(entry.lid, entry.points)
				}
				for (const entry of data.pointsByPn ?? []) {
					if (legacy) {
						// Legacy: use pn as the key (best-effort migration)
						pointsByLid.set(entry.pn, entry.points)
					} else {
						// Backward compatibility: accept old field name if present.
						pointsByLid.set(entry.pn, entry.points)
					}
				}
				for (const entry of data.reachedAtByLid ?? []) {
					reachedAtByLid.set(entry.lid, entry.reachedAt)
				}
				this.groups.set(groupId, {
					groupId,
					members: data.members ?? [],
					pointsByLid,
					reachedAtByLid,
				})
			}
		} catch {
			// Malformed — skip
		}
	}

	async persist(): Promise<void> {
		const snapshot: SeasonPointsSnapshot = {
			version: 1,
			updatedAt: new Date().toISOString(),
			groups: {},
		}
		for (const [groupId, state] of this.groups.entries()) {
			snapshot.groups[groupId] = {
				pointsByLid: [...state.pointsByLid.entries()].map(([lid, points]) => ({ lid, points })),
				reachedAtByLid: [...state.reachedAtByLid.entries()].map(([lid, reachedAt]) => ({ lid, reachedAt })),
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
		return this.groups.get(groupId)?.pointsByLid ?? new Map()
	}

	getMembers(groupId: string): ReadonlyArray<NMember> {
		return this.groups.get(groupId)?.members ?? []
	}

	getReachedAt(groupId: string): Map<string, number> {
		return this.groups.get(groupId)?.reachedAtByLid ?? new Map()
	}

	async addPoints(
		groupId: string,
		members: ReadonlyArray<NMember>,
		pointsByLid: ReadonlyMap<string, number>,
	): Promise<void> {
		let state = this.groups.get(groupId)
		if (!state) {
			state = { groupId, members, pointsByLid: new Map(), reachedAtByLid: new Map() }
			this.groups.set(groupId, state)
		}
		const now = Date.now()
		for (const [lid, points] of pointsByLid.entries()) {
			const current = state.pointsByLid.get(lid) ?? 0
			state.pointsByLid.set(lid, current + points)
			if (points > 0) {
				state.reachedAtByLid.set(lid, now)
			}
		}
		await this.persist()
	}

	async resetGroup(groupId: string): Promise<void> {
		const state = this.groups.get(groupId)
		if (state) {
			state.pointsByLid.clear()
			state.reachedAtByLid.clear()
		}
		await this.persist()
	}

	async setGroupMembers(
		groupId: string,
		members: ReadonlyArray<NMember>,
	): Promise<void> {
		let state = this.groups.get(groupId)
		if (!state) {
			state = { groupId, members, pointsByLid: new Map(), reachedAtByLid: new Map() }
			this.groups.set(groupId, state)
		} else {
			state.members = members
		}
		await this.persist()
	}

	listGroups(): string[] {
		return [...this.groups.keys()]
	}

	async adjustPoints(groupId: string, memberLid: string, delta: number): Promise<void> {
		let state = this.groups.get(groupId)
		if (!state) {
			state = { groupId, members: [], pointsByLid: new Map(), reachedAtByLid: new Map() }
			this.groups.set(groupId, state)
		}
		const current = state.pointsByLid.get(memberLid) ?? 0
		state.pointsByLid.set(memberLid, current + delta)
		if (delta > 0) {
			state.reachedAtByLid.set(memberLid, Date.now())
		}
	}

	async setPoints(groupId: string, memberLid: string, points: number): Promise<void> {
		let state = this.groups.get(groupId)
		if (!state) {
			state = { groupId, members: [], pointsByLid: new Map(), reachedAtByLid: new Map() }
			this.groups.set(groupId, state)
		}
		if (points <= 0) {
			state.pointsByLid.delete(memberLid)
			state.reachedAtByLid.delete(memberLid)
		} else {
			state.pointsByLid.set(memberLid, points)
			state.reachedAtByLid.set(memberLid, Date.now())
		}
	}

	async clearAll(): Promise<void> {
		this.groups.clear()
		await this.persist()
	}
}
