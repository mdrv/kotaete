import { Crust } from '@crustjs/core'

export const app = new Crust('kotaete')
	.meta({ description: 'NIPBANG Kotaete WhatsApp quiz daemon/relay CLI' })
	.flags({
		debug: { type: 'boolean', short: 'd', description: 'Verbose logging', inherit: true },
		json: { type: 'boolean', short: 'j', description: 'JSON output', inherit: true },
	})

import { createConnection } from 'node:net'
import type { RelayRequest, RelayResponse } from '../daemon/protocol.ts'

export async function sendRelayRequest(
	socketPath: string,
	payload: RelayRequest,
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
