import { configure, getConsoleSink, getLogger } from '@logtape/logtape'
import { getPrettyFormatter } from '@logtape/pretty'

export { getLogger }

let initialized = false

export async function initWebLogger() {
	if (initialized) return

	await configure({
		reset: true,
		sinks: {
			console: getConsoleSink({
				formatter: getPrettyFormatter(),
			}),
		},
		loggers: [
			{ category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['console'] },
			{ category: ['kotaete', 'web'], lowestLevel: 'debug', sinks: ['console'] },
		],
	})

	initialized = true
	getLogger(['kotaete', 'web']).info('logger initialized')
}