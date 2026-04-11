import { DEFAULT_SOCKET_PATH } from '../../constants.ts'
import { expandHome } from '../../utils/path.ts'
import { app, sendRelayRequest } from '../shared.ts'

export const pluginCmd = app.sub('plugin')
	.meta({ description: 'Manage daemon plugins' })
	.command(
		app
			.sub('enable')
			.meta({ description: 'Enable a plugin in the running daemon' })
			.flags({
				socket: { type: 'string', description: 'Path to daemon socket' },
				arg: { type: 'string', description: 'Plugin argument (key=value)', multiple: true },
			})
			.args([{ name: 'source', type: 'string', required: true }])
			.run(async ({ args, flags }) => {
				const socketPath = expandHome(flags.socket ?? DEFAULT_SOCKET_PATH)
				const pluginArgs: Record<string, string> = {}
				if (flags.arg) {
					const rawArgs = Array.isArray(flags.arg) ? flags.arg : [flags.arg]
					for (const raw of rawArgs) {
						const eqIndex = raw.indexOf('=')
						if (eqIndex === -1) {
							console.error(`invalid --arg format "${raw}": expected key=value`)
							process.exit(1)
						}
						const key = raw.slice(0, eqIndex)
						const value = raw.slice(eqIndex + 1)
						pluginArgs[key] = value
					}
				}

				const response = await sendRelayRequest(socketPath, {
					type: 'plugin-enable',
					sourcePath: args.source,
					args: Object.keys(pluginArgs).length > 0 ? pluginArgs : undefined,
				})

				if (!response.ok) {
					console.error(`❌ ${response.message}`)
					process.exit(1)
				}

				console.log(`✅ ${response.message}`)
			}),
	)
	.command(
		app
			.sub('disable')
			.meta({ description: 'Disable a plugin in the running daemon' })
			.flags({
				socket: { type: 'string', description: 'Path to daemon socket' },
			})
			.args([{ name: 'name', type: 'string', required: true }])
			.run(async ({ args, flags }) => {
				const socketPath = expandHome(flags.socket ?? DEFAULT_SOCKET_PATH)

				const response = await sendRelayRequest(socketPath, {
					type: 'plugin-disable',
					name: args.name,
				})

				if (!response.ok) {
					console.error(`❌ ${response.message}`)
					process.exit(1)
				}

				console.log(`✅ ${response.message}`)
			}),
	)
	.command(
		app
			.sub('list')
			.meta({ description: 'List loaded plugins in the running daemon' })
			.flags({
				socket: { type: 'string', description: 'Path to daemon socket' },
				json: { type: 'boolean', description: 'Output as JSON' },
			})
			.run(async ({ flags }) => {
				const socketPath = expandHome(flags.socket ?? DEFAULT_SOCKET_PATH)

				const response = await sendRelayRequest(socketPath, {
					type: 'plugin-list',
				})

				if (!response.ok) {
					console.error(`❌ ${response.message}`)
					process.exit(1)
				}

				if (flags.json) {
					console.log(JSON.stringify(response.plugins ?? [], null, 2))
					return
				}

				console.log(response.message)
			}),
	)
