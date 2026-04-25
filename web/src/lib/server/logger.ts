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
				formatter: getPrettyFormatter({
					timestamp: (ts: number) => {
						const d = new Date(ts)
						const hh = String(d.getHours()).padStart(2, '0')
						const mm = String(d.getMinutes()).padStart(2, '0')
						return `${hh}:${mm}`
					},
				}),
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
