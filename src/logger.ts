import { configure, getConsoleSink, getLogger, type LogLevel, type LogRecord, type Sink } from '@logtape/logtape'
import { getPrettyFormatter } from '@logtape/pretty'

export { getLogger }

export type InitLoggerOptions = {
	/**
	 * Enable file logging. When true, logs are written to ~/.kotaete/logs/.
	 */
	fileSink?: boolean
	/**
	 * Label for the log file (e.g. "daemon"). Used in the filename.
	 */
	instanceLabel?: string
}

let initialized = false

const LOG_LEVEL_ORDER: Record<string, number> = {
	trace: 5,
	debug: 10,
	info: 20,
	warning: 30,
	error: 40,
	fatal: 50,
}

/** Wrap a sink so it only forwards records at or above the given level. */
function filterSinkByLevel(inner: Sink, minLevel: LogLevel): Sink {
	const threshold = LOG_LEVEL_ORDER[minLevel]
	return (record: LogRecord) => {
		if ((LOG_LEVEL_ORDER[record.level] ?? 0) >= (threshold ?? 0)) {
			inner(record)
		}
	}
}

function makeConsoleSink(): Sink {
	return getConsoleSink({
		formatter: getPrettyFormatter(),
	})
}

export async function initLogger(level: LogLevel = 'info', options?: InitLoggerOptions): Promise<void> {
	if (initialized) return

	const hasFileSink = Boolean(options?.fileSink)

	if (hasFileSink && options) {
		// File sink: always captures debug+ for full diagnostics.
		// Console sink: wrapped to respect the requested level.
		// Both share one category entry set to debug so nothing is lost.
		const { getRotatingFileSink } = await import('@logtape/file')
		const label = options.instanceLabel ?? 'app'
		const home = process.env.HOME ?? '~'
		const logDir = home === '~' ? '.kotaete/logs' : `${home}/.kotaete/logs`
		const { mkdir } = await import('node:fs/promises')
		await mkdir(logDir, { recursive: true })

		const logPath = `${logDir}/${label}-${process.pid}.log`
		await configure({
			reset: true,
			sinks: {
				console: filterSinkByLevel(makeConsoleSink(), level),
				file: getRotatingFileSink(logPath, {
					maxSize: 16 * 1024,
					maxFiles: 5,
				}),
			},
			loggers: [
				{ category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['console', 'file'] },
				{ category: ['kotaete'], lowestLevel: 'debug', sinks: ['console', 'file'] },
			],
		})
	} else {
		await configure({
			reset: true,
			sinks: { console: makeConsoleSink() },
			loggers: [
				{ category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['console'] },
				{ category: ['kotaete'], lowestLevel: level, sinks: ['console'] },
			],
		})
	}

	initialized = true
}
