import { DEFAULT_SOCKET_PATH } from '../../constants.ts'
import { expandHome } from '../../utils/path.ts'
import { sendRelayRequest } from '../shared.ts'
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
