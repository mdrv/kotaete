import { SeasonStore } from '../../quiz/season-store.ts'
import { app } from '../shared.ts'

export const seasonCmd = app
	.sub('season')
	.meta({ description: 'View and manipulate season scores' })
	.command(
		app
			.sub('stop')
			.meta({ description: 'Stop a season for a group, optionally showing scoreboard' })
			.args([{ name: 'groupId', type: 'string', required: true }])
			.flags({
				scoreboard: {
					type: 'boolean',
					default: true,
					description: 'Generate and send the final scoreboard to the group (use --no-scoreboard to disable)',
				},
			})
			.run(async ({ args, flags }) => {
				const { sendRelayRequest } = await import('../shared.ts')
				const { DEFAULT_SOCKET_PATH } = await import('../../constants.ts')
				const { expandHome } = await import('../../utils/path.ts')

				const socketPath = expandHome(DEFAULT_SOCKET_PATH)
				const response = await sendRelayRequest(socketPath, {
					type: 'season-stop',
					groupId: args.groupId,
					noScoreboard: flags.scoreboard === false,
				})

				if (flags.json) {
					console.log(JSON.stringify(response, null, 2))
					return
				}

				if (!response.ok) {
					console.error(`❌ ${response.message}`)
					process.exit(1)
				}

				console.log(`✅ ${response.message}`)
			}),
	)
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

					const reachedAt = store.getReachedAt(args.groupId)
					const entries = [...points.entries()]
						.map(([mid, pts]) => {
							const member = members.find((m) => m.mid === mid)
							return {
								mid,
								name: member?.kananame ?? member?.nickname ?? mid,
								points: pts,
								reachedAt: reachedAt.get(mid) ?? Infinity,
							}
						})
						.sort((a, b) => {
							if (b.points !== a.points) return b.points - a.points
							return a.reachedAt - b.reachedAt
						})

					if (flags.json) {
						console.log(JSON.stringify({ ok: true, groupId: args.groupId, entries }, null, 2))
						return
					}

					console.log(`Season scores for ${args.groupId}:`)
					for (const entry of entries) {
						console.log(`  ${entry.points}\t${entry.name} [${entry.mid}]`)
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
					const reachedAt = store.getReachedAt(groupId)
					const entries = [...points.entries()]
						.map(([mid, pts]) => {
							const member = members.find((m) => m.mid === mid)
							return {
								mid,
								name: member?.kananame ?? member?.nickname ?? mid,
								points: pts,
								reachedAt: reachedAt.get(mid) ?? Infinity,
							}
						})
						.sort((a, b) => {
							if (b.points !== a.points) return b.points - a.points
							return a.reachedAt - b.reachedAt
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
							console.log(`  ${entry.points}\t${entry.name} [${entry.mid}]`)
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
				{ name: 'memberMid', type: 'string', required: true },
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
				await store.adjustPoints(args.groupId, args.memberMid, delta)
				await store.persist()

				const current = store.getPoints(args.groupId).get(args.memberMid) ?? 0
				if (flags.json) {
					console.log(
						JSON.stringify(
							{ ok: true, groupId: args.groupId, mid: args.memberMid, delta, total: current },
							null,
							2,
						),
					)
					return
				}
				console.log(`✅ ${args.memberMid}: +${delta} → ${current} pts`)
			}),
	)
	.command(
		app
			.sub('set')
			.meta({ description: 'Set absolute season points (if <=0 remove entry)' })
			.args([
				{ name: 'groupId', type: 'string', required: true },
				{ name: 'memberMid', type: 'string', required: true },
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
				await store.setPoints(args.groupId, args.memberMid, points)
				await store.persist()

				if (flags.json) {
					console.log(
						JSON.stringify(
							{ ok: true, groupId: args.groupId, mid: args.memberMid, points },
							null,
							2,
						),
					)
					return
				}
				console.log(`✅ ${args.memberMid}: set to ${points} pts`)
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
