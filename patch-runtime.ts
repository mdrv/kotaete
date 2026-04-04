import { readFile, writeFile } from 'fs/promises'

const file = await readFile('src/daemon/runtime.ts', 'utf-8')
const insertMarker = "if (parsed.data.type === 'lookup-mapping') {"

const patch = `
							if (parsed.data.type === 'season-stop') {
								const groupId = parsed.data.groupId
								const allJobs = [...this.jobs.values()].filter(j => j.meta.groupId === groupId)
								
								// First find a bundle to use for formatting
								let sampleBundle: any = null
								for (const job of allJobs) {
									// stop current jobs WITHOUT sending the final season scoreboard from engine
									// because we will send it here
									const engine = job.engine
									const stopped = await engine.stopCurrentQuizWithFinal() // This sends quiz scoreboard
									// The engine only sends season scoreboard if bundle.season.end is true. 
									// Assuming it is false or we don't care, we'll just send it below.
									if (!sampleBundle) {
										sampleBundle = (engine as any).state?.bundle
									}
									this.finishJob(job.id)
								}

								if (!parsed.data.noScoreboard) {
									const seasonPoints = this.seasonStore.getPoints(groupId)
									const seasonMembers = this.seasonStore.getMembers(groupId)
									if (seasonPoints.size > 0) {
										const seasonRows = [...seasonPoints.entries()]
											.map(([lid, points]) => ({
												member: sampleBundle?.members?.find((m: any) => m.lid === lid) ?? seasonMembers.find((m) => m.lid === lid) ?? null,
												points,
											}))
											.sort((a, b) => {
												if (b.points !== a.points) return b.points - a.points
												return (a.member?.lid ?? '').localeCompare(b.member?.lid ?? '')
											})

										const top3 = seasonRows.slice(0, 3)
										const topSlots = seasonRows.slice(0, 7).map((entry, index) => ({
											rank: index + 1,
											lid: entry.member?.lid ?? '',
											pn: entry.member?.pn ?? undefined,
											name: entry.member?.kananame ?? entry.member?.nickname ?? 'Unknown',
											points: entry.points,
											colorHex: undefined,
										}))

										try {
											const { generateSeasonScoreboardImage } = await import('../quiz/season-scoreboard.ts')
											const scoreboardOutput = await generateSeasonScoreboardImage(topSlots, {
												...(sampleBundle?.season?.scoreboardTemplate ? { templatePath: sampleBundle.season.scoreboardTemplate } : {}),
												outputStem: 'season-scoreboard',
											})

											const { formatSeasonTopMessage, formatSeasonOthersMessage } = await import('../quiz/messages.ts')
											const imgCaption = formatSeasonTopMessage(top3, sampleBundle?.season?.caption)
											await this.enqueueOutbound(groupId, () => this.wa.sendImageWithCaption(groupId, scoreboardOutput.jpgPath, imgCaption), { typing: true })

											const othersMessage = formatSeasonOthersMessage(seasonRows)
											if (othersMessage) {
												await this.enqueueOutbound(groupId, () => this.wa.sendText(groupId, othersMessage, { linkPreview: false }), { typing: true })
											}
										} catch (error) {
											const { log } = await import('../logger.ts')
											log.warning(\`season scoreboard image generation failed in daemon: \${error instanceof Error ? error.message : String(error)}\`)
										}
									}
								}

								await this.seasonStore.resetGroup(groupId)

								writeResponse(socket, {
									ok: true,
									message: \`Season stopped for \${groupId}. \${allJobs.length} active quiz(zes) stopped.\`
								})
								return
							}

`

const result = file.replace(insertMarker, patch + insertMarker)
await writeFile('src/daemon/runtime.ts', result)
