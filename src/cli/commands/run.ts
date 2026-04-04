import { createConnection } from 'node:net'
import { DEFAULT_SOCKET_PATH } from '../../constants.ts'
import type { RelayResponse } from '../../daemon/protocol.ts'
import type { QuizRunPayload } from '../../types.ts'
import { expandHome } from '../../utils/path.ts'

async function sendRelayRequest(
	socketPath: string,
	payload: QuizRunPayload & { type: 'run-quiz' },
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

export function createRunHandler() {
	return async ({ args, flags }: { args: { sources: string[] }; flags: Record<string, unknown> }) => {
		const socketPath = expandHome(DEFAULT_SOCKET_PATH)
		const sources = (args.sources as string[]).map((value) => expandHome(value))
		const noGeneration = flags.generation !== true
		const response = await sendRelayRequest(socketPath, {
			type: 'run-quiz',
			sources,
			noCooldown: flags.cooldown === false,
			noSchedule: flags.schedule === false,
			noGeneration,
			...(flags['save-svg'] === true ? { saveSvg: true } : {}),
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
	}
}
