import { Crust } from '@crustjs/core'

export const app = new Crust('kotaete')
	.meta({ description: 'NIPBANG Kotaete WhatsApp quiz daemon/relay CLI' })
	.flags({
		debug: { type: 'boolean', short: 'd', description: 'Verbose logging', inherit: true },
		json: { type: 'boolean', short: 'j', description: 'JSON output', inherit: true },
	})
