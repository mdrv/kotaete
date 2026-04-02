import { createConnection } from 'node:net'
import { DEFAULT_SOCKET_PATH } from '../../constants.ts'
import type { RelayResponse } from '../../daemon/protocol.ts'
import { expandHome } from '../../utils/path.ts'
import { app } from '../shared.ts'

type QuizControlPayload = {
	type: 'quiz-status' | 'quiz-stop'
}

async function sendQuizControlRequest(
	socketPath: string,
	payload: QuizControlPayload,
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

async function runControl(
	payload: QuizControlPayload,
	flags: { socket?: string | undefined; json?: boolean | undefined },
): Promise<void> {
	const socketPath = expandHome(flags.socket ?? DEFAULT_SOCKET_PATH)
	const response = await sendQuizControlRequest(socketPath, payload)

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

export const quizCmd = app
	.sub('quiz')
	.meta({ description: 'Quiz lifecycle control and status' })
	.command(
		app
			.sub('status')
			.meta({ description: 'Show active quiz status on daemon' })
			.run(async ({ flags }) => {
				await runControl({ type: 'quiz-status' }, flags)
			}),
	)
	.command(
		app
			.sub('stop')
			.meta({ description: 'Stop currently running quiz on daemon' })
			.run(async ({ flags }) => {
				await runControl({ type: 'quiz-stop' }, flags)
			}),
	)
