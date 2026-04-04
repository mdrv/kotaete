import { SeasonStore } from '../../quiz/season-store.ts'
import { app } from '../shared.ts'

export const seasonCmd = app
	.sub('season')
	.meta({ description: 'View and manipulate season scores' })
	.command(
		app
			.sub('show')
			.meta({ description: 'Show saved season scores (all groups or one group)' })
			.args([{ name: 'groupId', type: 'string' }])
			.run(async ({ args, flags }) => {
				const store = new SeasonStore()
				await store.load()
				const groups = store.listGroups()

				if (args.groupId) {
					const points = store.getPoints(args.groupId)
					const members = store.getMembers(args.groupId)
					if (points.size === 0) {
						if (flags.json) {
							console.log(JSON.stringify({ ok: true, groupId: args.groupId, entries: [] }, null, 2))
							return
						}
						console.log(`No season data for group ${args.groupId}`)
						return
					}

					const entries = [...points.entries()]
						.sort((a, b) => b[1] - a[1])
						.map(([lid, pts]) => {
							const member = members.find((m) => m.lid === lid)
							return {
								lid,
								pn: member?.pn ?? undefined,
								name: member?.kananame ?? member?.nickname ?? lid,
								points: pts,
							}
						})

					if (flags.json) {
						console.log(JSON.stringify({ ok: true, groupId: args.groupId, entries }, null, 2))
						return
					}

					console.log(`Season scores for ${args.groupId}:`)
					for (const entry of entries) {
						const pnSuffix = entry.pn ? ` (${entry.pn})` : ''
						console.log(`  ${entry.points}\t${entry.name} [${entry.lid}]${pnSuffix}`)
					}
					return
				}

				// All groups
				if (groups.length === 0) {
					if (flags.json) {
						console.log(JSON.stringify({ ok: true, groups: [] }, null, 2))
						return
					}
					console.log('No season data')
					return
				}

				const result = groups.map((groupId) => {
					const points = store.getPoints(groupId)
					const members = store.getMembers(groupId)
					const entries = [...points.entries()]
						.sort((a, b) => b[1] - a[1])
						.map(([lid, pts]) => {
							const member = members.find((m) => m.lid === lid)
							return {
								lid,
								pn: member?.pn ?? undefined,
								name: member?.kananame ?? member?.nickname ?? lid,
								points: pts,
							}
						})
					return { groupId, entries }
				})

				if (flags.json) {
					console.log(JSON.stringify({ ok: true, groups: result }, null, 2))
					return
				}

				for (const group of result) {
					console.log(`Season scores for ${group.groupId}:`)
					if (group.entries.length === 0) {
						console.log('  (empty)')
					} else {
						for (const entry of group.entries) {
							const pnSuffix = entry.pn ? ` (${entry.pn})` : ''
							console.log(`  ${entry.points}\t${entry.name} [${entry.lid}]${pnSuffix}`)
						}
					}
					console.log('')
				}
			}),
	)
	.command(
		app
			.sub('add')
			.meta({ description: 'Adjust season points by signed integer delta' })
			.args([
				{ name: 'groupId', type: 'string', required: true },
				{ name: 'memberLid', type: 'string', required: true },
				{ name: 'points', type: 'string', required: true },
			])
			.run(async ({ args, flags }) => {
				const delta = Number(args.points)
				if (!Number.isFinite(delta)) {
					console.error('❌ points must be a number')
					process.exit(1)
				}

				const store = new SeasonStore()
				await store.load()
				await store.adjustPoints(args.groupId, args.memberLid, delta)
				await store.persist()

				const current = store.getPoints(args.groupId).get(args.memberLid) ?? 0
				if (flags.json) {
					console.log(
						JSON.stringify(
							{ ok: true, groupId: args.groupId, lid: args.memberLid, delta, total: current },
							null,
							2,
						),
					)
					return
				}
				console.log(`✅ ${args.memberLid}: +${delta} → ${current} pts`)
			}),
	)
	.command(
		app
			.sub('set')
			.meta({ description: 'Set absolute season points (if <=0 remove entry)' })
			.args([
				{ name: 'groupId', type: 'string', required: true },
				{ name: 'memberLid', type: 'string', required: true },
				{ name: 'points', type: 'string', required: true },
			])
			.run(async ({ args, flags }) => {
				const points = Number(args.points)
				if (!Number.isFinite(points)) {
					console.error('❌ points must be a number')
					process.exit(1)
				}

				const store = new SeasonStore()
				await store.load()
				await store.setPoints(args.groupId, args.memberLid, points)
				await store.persist()

				if (flags.json) {
					console.log(
						JSON.stringify(
							{ ok: true, groupId: args.groupId, lid: args.memberLid, points },
							null,
							2,
						),
					)
					return
				}
				console.log(`✅ ${args.memberLid}: set to ${points} pts`)
			}),
	)
	.command(
		app
			.sub('reset')
			.meta({ description: 'Clear season points for one group' })
			.args([{ name: 'groupId', type: 'string', required: true }])
			.run(async ({ args, flags }) => {
				const store = new SeasonStore()
				await store.load()
				await store.resetGroup(args.groupId)

				if (flags.json) {
					console.log(JSON.stringify({ ok: true, groupId: args.groupId, reset: true }, null, 2))
					return
				}
				console.log(`✅ Season points cleared for ${args.groupId}`)
			}),
	)
	.command(
		app
			.sub('clear')
			.meta({ description: 'Clear all season data' })
			.run(async ({ flags }) => {
				const store = new SeasonStore()
				await store.load()
				await store.clearAll()

				if (flags.json) {
					console.log(JSON.stringify({ ok: true, cleared: true }, null, 2))
					return
				}
				console.log('✅ All season data cleared')
			}),
	)
