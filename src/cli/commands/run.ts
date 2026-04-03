import { createConnection } from 'node:net'
import { DEFAULT_SOCKET_PATH } from '../../constants.ts'
import type { RelayResponse } from '../../daemon/protocol.ts'
import { expandHome } from '../../utils/path.ts'
import { app } from '../shared.ts'

async function sendRelayRequest(
	socketPath: string,
	payload: {
		type: 'run-quiz'
		groupId: string
		quizDir: string
		membersFile: string
		disableCooldown?: boolean
		noSchedule?: boolean
	},
): Promise<RelayResponse> {
	return await new Promise<RelayResponse>((resolve, reject) => {
		const socket = createConnection({ path: socketPath }, () => {
			socket.write(`${JSON.stringify(payload)}\n`)
		})

		let data = ''
		socket.on('data', (chunk) => {
			data += chunk.toString('utf-8')
			if (!data.includes('\n')) return
			const line = data.split('\n')[0]?.trim() ?? ''
			if (!line) {
				reject(new Error('daemon sent empty response'))
				socket.end()
				return
			}
			try {
				const parsed = JSON.parse(line) as RelayResponse
				resolve(parsed)
			} catch (error) {
				reject(error)
			}
			socket.end()
		})

		socket.on('error', reject)
	})
}

export const runCmd = app.sub('run')
	.meta({ description: 'Relay request to daemon to run a quiz' })
	.flags({
		cooldown: {
			type: 'boolean',
			description: 'Enable answer cooldown (default)',
			default: true,
		},
		schedule: {
			type: 'boolean',
			description: 'Use configured intro/start schedule from quiz config (default)',
			default: true,
		},
	})
	.args([
		{ name: 'groupId', type: 'string', required: true },
		{ name: 'quizDir', type: 'string', required: true },
		{ name: 'membersFile', type: 'string', required: true },
	])
	.run(async ({ args, flags }) => {
		const socketPath = expandHome(flags.socket ?? DEFAULT_SOCKET_PATH)
		const quizDir = expandHome(args.quizDir)
		const membersFile = expandHome(args.membersFile)
		const response = await sendRelayRequest(socketPath, {
			type: 'run-quiz',
			groupId: args.groupId,
			quizDir,
			membersFile,
			disableCooldown: flags.cooldown === false,
			noSchedule: flags.schedule === false,
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
	})
