import { configure, getConsoleSink, getLogger, type LogLevel, type Sink } from '@logtape/logtape'
import { getPrettyFormatter } from '@logtape/pretty'

export { getLogger }

let initialized = false

function makeConsoleSink(): Sink {
	return getConsoleSink({
		formatter: getPrettyFormatter(),
	})
}

export async function initLogger(level: LogLevel = 'info'): Promise<void> {
	if (initialized) return
	await configure({
		reset: true,
		sinks: {
			console: makeConsoleSink(),
		},
		loggers: [
			{ category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['console'] },
			{ category: ['kotaete'], lowestLevel: level, sinks: ['console'] },
		],
	})
	initialized = true
}
