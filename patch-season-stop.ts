import { readFile, writeFile } from 'fs/promises'

const file = await readFile('src/cli/commands/season.ts', 'utf-8')
const insertIndex = file.indexOf('.command(')

const patch = `
	.command(
		app
			.sub('stop')
			.meta({ description: 'Stop a season for a group, optionally showing scoreboard' })
			.args([{ name: 'groupId', type: 'string', required: true }])
			.flags({ 'no-scoreboard': { type: 'boolean', description: 'Do not generate or send the final scoreboard to the group' } })
			.run(async ({ args, flags }) => {
				const { sendRelayRequest } = await import('../shared.ts')
				const { DEFAULT_SOCKET_PATH } = await import('../../constants.ts')
				const { expandHome } = await import('../../utils/path.ts')

				const socketPath = expandHome(DEFAULT_SOCKET_PATH)
				const response = await sendRelayRequest(socketPath, {
					type: 'season-stop',
					groupId: args.groupId,
					noScoreboard: flags['no-scoreboard'] === true,
				})

				if (flags.json) {
					console.log(JSON.stringify(response, null, 2))
					return
				}

				if (!response.ok) {
					console.error(\`❌ \${response.message}\`)
					process.exit(1)
				}

				console.log(\`✅ \${response.message}\`)
			})
	)
`

const result = file.slice(0, insertIndex) + patch + file.slice(insertIndex)
await writeFile('src/cli/commands/season.ts', result)
