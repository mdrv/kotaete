import { DaemonRuntime } from '../../daemon/runtime.ts'
import { initLogger } from '../../logger.ts'
import { app } from '../shared.ts'

export const daemonCmd = app.sub('daemon')
	.meta({ description: 'Start WhatsApp daemon and listen for relay requests' })
	.run(async ({ flags }) => {
		await initLogger(flags.debug ? 'debug' : 'info')
		const opts: { socketPath?: string; authDir?: string; provider?: string } = {}
		if (flags.socket !== undefined) opts.socketPath = flags.socket
		if (flags.auth !== undefined) opts.authDir = flags.auth
		if (flags.provider !== undefined) opts.provider = flags.provider
		const runtime = new DaemonRuntime(opts)
		await runtime.start()
	})
