import { Crust } from '@crustjs/core'

export const app = new Crust('kotaete')
	.meta({ description: 'NIPBANG Kotaete WhatsApp quiz daemon/relay CLI' })
	.flags({
		debug: { type: 'boolean', short: 'd', description: 'Verbose logging', inherit: true },
		json: { type: 'boolean', short: 'j', description: 'JSON output', inherit: true },
		socket: { type: 'string', description: 'Daemon unix socket path', inherit: true },
		auth: { type: 'string', description: 'WhatsApp auth directory path', inherit: true },
		provider: {
			type: 'string',
			description: 'WhatsApp provider: wwebjs (default) or baileys (experimental)',
			inherit: true,
		},
	})
