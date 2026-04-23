import { select } from '@crustjs/prompts'
import { createConnection } from 'node:net'
import { DEFAULT_SOCKET_PATH } from '../../constants.ts'
import type { RelayResponse } from '../../daemon/protocol.ts'
import { expandHome } from '../../utils/path.ts'
import { app } from '../shared.ts'
import { createRunHandler } from './run.ts'

type QuizControlPayload = {
	type: 'quiz-status' | 'quiz-stop'
	id?: string
	silent?: boolean | undefined
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
	flags: { json?: boolean | undefined },
): Promise<void> {
	const socketPath = expandHome(DEFAULT_SOCKET_PATH)
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

async function promptSelection(options: Array<{ id: string; label: string }>): Promise<string> {
	return await select({
		message: 'Select a job to stop',
		choices: options.map((opt) => ({
			value: opt.id,
			label: `${opt.id}  ${opt.label}`,
		})),
	})
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
			.meta({ description: 'Stop a running quiz on daemon' })
			.flags({
				silent: { type: 'boolean', description: 'Stop the quiz silently without showing final scoreboard' },
			})
			.args([{ name: 'id', type: 'string' }])
			.run(async ({ args, flags }) => {
				const socketPath = expandHome(DEFAULT_SOCKET_PATH)

				if (args.id) {
					await runControl({ type: 'quiz-stop', id: args.id, silent: flags.silent }, flags)
					return
				}
				// No id provided — fetch status first
				const statusResponse = await sendQuizControlRequest(socketPath, { type: 'quiz-status' })
				const jobs = statusResponse.jobs ?? []

				if (jobs.length === 0) {
					if (flags.json) {
						console.log(JSON.stringify({ ok: false, message: 'no active quiz jobs to stop' }, null, 2))
						return
					}
					console.error('❌ no active quiz jobs to stop')
					process.exit(1)
				}

				if (jobs.length === 1) {
					await runControl({ type: 'quiz-stop', id: jobs[0]!.id, silent: flags.silent }, flags)
					return
				}

				// Multiple jobs
				if (flags.json) {
					console.log(
						JSON.stringify(
							{
								ok: false,
								message: `multiple jobs active — pass an id to stop a specific job`,
								jobs,
							},
							null,
							2,
						),
					)
					return
				}

				const options = jobs.map((j) => ({
					id: j.id,
					label: `group=${j.groupId} quizDir=${j.quizDir}`,
				}))
				let selectedId: string
				try {
					selectedId = await promptSelection(options)
				} catch (error) {
					console.error(
						`❌ ${error instanceof Error ? error.message : String(error)}\nPass a job id: kotaete quiz stop <id>`,
					)
					process.exit(1)
					return
				}
				await runControl({ type: 'quiz-stop', id: selectedId, silent: flags.silent }, flags)
			}),
	)
	// `kotaete quiz run` — relay request to daemon
	.command(
		app
			.sub('run')
			.meta({ description: 'Relay request to daemon to run a quiz' })
			.flags({
				cooldown: {
					type: 'boolean',
					description: 'Enable answer cooldown (default)',
					default: true,
				},
				generation: {
					type: 'boolean',
					description: 'Enable image generation from SVG templates (default: disabled)',
					default: false,
				},
				schedule: {
					type: 'boolean',
					description: 'Use configured intro/start schedule from quiz config (default)',
					default: true,
				},
				'save-svg': {
					type: 'boolean',
					description: 'Keep rendered SVG file in quiz directory alongside generated image',
					default: false,
				},
			})
			.args([{ name: 'sources', type: 'string', variadic: true, required: true }])
			.run(createRunHandler()),
	)
