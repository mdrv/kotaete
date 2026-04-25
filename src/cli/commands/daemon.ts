import { DaemonRuntime } from '../../daemon/runtime.ts'
import { initLogger } from '../../logger.ts'
import { app } from '../shared.ts'

export const daemonCmd = app.sub('daemon')
	.flags({
		fresh: { type: 'boolean', description: 'Start fresh — ignore/clear persisted runtime state' },
		trace: { type: 'boolean', description: 'Enable trace-level logging (includes heartbeat, internal state)' },
		socket: { type: 'string', description: 'Daemon unix socket path' },
		auth: { type: 'string', description: 'WhatsApp auth directory path' },
		provider: {
			type: 'string',
			description: 'WhatsApp provider: wwebjs (default) or baileys (experimental)',
		},
	})
	.meta({ description: 'Start WhatsApp daemon and listen for relay requests' })
	.run(async ({ flags }) => {
		const logLevel = flags.trace ? 'trace' : flags.debug ? 'debug' : 'info'
		await initLogger(logLevel, { fileSink: true, instanceLabel: 'daemon' })
		const opts: { socketPath?: string; authDir?: string; provider?: string; fresh?: boolean } = {}
		if (flags.socket !== undefined) opts.socketPath = flags.socket
		if (flags.auth !== undefined) opts.authDir = flags.auth
		if (flags.provider !== undefined) opts.provider = flags.provider
		if (flags.fresh) opts.fresh = true
		const runtime = new DaemonRuntime(opts)
		await runtime.start()
	})
