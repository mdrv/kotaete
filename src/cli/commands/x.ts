import { DEFAULT_SOCKET_PATH } from '../../constants.ts'
import { expandHome } from '../../utils/path.ts'
import { app, sendRelayRequest } from '../shared.ts'

export const xCmd = app.sub('x')
	.meta({ description: 'Plugin-specific commands for running daemon' })
	.command(
		app
			.sub('ask')
			.meta({ description: 'Manage the ask plugin' })
			.command(
				app
					.sub('close')
					.meta({ description: 'Close ask plugin (responds with closed message)' })
					.flags({
						socket: { type: 'string', description: 'Path to daemon socket' },
						message: { type: 'string', description: 'Custom closed message' },
					})
					.run(async ({ flags }) => {
						const socketPath = expandHome(flags.socket ?? DEFAULT_SOCKET_PATH)
						const response = await sendRelayRequest(socketPath, {
							type: 'plugin-ask',
							action: 'close',
							message: flags.message,
						})
						if (!response.ok) {
							console.error(`\u274C ${response.message}`)
							process.exit(1)
						}
						console.log(`\u2705 ${response.message}`)
					}),
			)
			.command(
				app
					.sub('open')
					.meta({ description: 'Re-open ask plugin for normal operation' })
					.flags({
						socket: { type: 'string', description: 'Path to daemon socket' },
					})
					.run(async ({ flags }) => {
						const socketPath = expandHome(flags.socket ?? DEFAULT_SOCKET_PATH)
						const response = await sendRelayRequest(socketPath, {
							type: 'plugin-ask',
							action: 'open',
						})
						if (!response.ok) {
							console.error(`\u274C ${response.message}`)
							process.exit(1)
						}
						console.log(`\u2705 ${response.message}`)
					}),
			)
			.command(
				app
					.sub('tool')
					.meta({ description: 'Run an ask plugin tool' })
					.flags({
						socket: { type: 'string', description: 'Path to daemon socket' },
						arg: { type: 'string', description: 'Tool argument', multiple: true },
					})
					.args([{ name: 'name', type: 'string', required: true }])
					.run(async ({ args, flags }) => {
						const socketPath = expandHome(flags.socket ?? DEFAULT_SOCKET_PATH)
						const toolArgs = Array.isArray(flags.arg) ? flags.arg : flags.arg ? [flags.arg] : []
						const response = await sendRelayRequest(socketPath, {
							type: 'plugin-ask',
							action: 'tool',
							tool: args.name,
							toolArgs,
						})
						if (!response.ok) {
							console.error(`\u274C ${response.message}`)
							process.exit(1)
						}
						console.log(response.data ?? response.message)
					}),
			),
	)
