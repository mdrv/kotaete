import { createConnection } from 'node:net'
import { DEFAULT_AUTH_DIR, DEFAULT_BAILEYS_AUTH_DIR, DEFAULT_SOCKET_PATH } from '../../constants.ts'
import type { RelayResponse } from '../../daemon/protocol.ts'
import { initLogger } from '../../logger.ts'
import { expandHome } from '../../utils/path.ts'
import { WhatsAppClient } from '../../whatsapp/client.ts'
import { LidPnStore } from '../../whatsapp/lid-pn-store.ts'
import { parseWhatsAppProvider } from '../../whatsapp/types.ts'
import { app } from '../shared.ts'

async function createStore(pathLike?: string): Promise<LidPnStore> {
	const store = new LidPnStore(pathLike)
	await store.load()
	return store
}

type LookupPayload = {
	type: 'lookup-mapping'
	direction: 'to-pn' | 'to-lid'
	value: string
}

async function sendLookupRequest(socketPath: string, payload: LookupPayload): Promise<RelayResponse> {
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
				resolve(JSON.parse(line) as RelayResponse)
			} catch (error) {
				reject(error)
			}
			socket.end()
		})

		socket.on('error', reject)
	})
}

async function lookupViaDaemon(
	flags: { socket: string | undefined; json: boolean | undefined },
	direction: 'to-pn' | 'to-lid',
	value: string,
): Promise<string | null> {
	const socketPath = expandHome(flags.socket ?? DEFAULT_SOCKET_PATH)
	try {
		const response = await sendLookupRequest(socketPath, {
			type: 'lookup-mapping',
			direction,
			value,
		})
		if (!response.ok) return null
		if (!response.message.trim()) return null
		return response.message.trim()
	} catch {
		return null
	}
}

type ToolFlags = {
	socket: string | undefined
	json: boolean | undefined
	provider: string | undefined
	auth: string | undefined
	debug: boolean | undefined
}

async function waitForClientConnection(client: WhatsAppClient, timeoutMs = 30_000): Promise<boolean> {
	if (await client.isConnected()) return true
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		await Bun.sleep(250)
		if (await client.isConnected()) return true
	}
	return false
}

async function lookupViaWhatsApp(
	flags: ToolFlags,
	direction: 'to-pn' | 'to-lid',
	value: string,
): Promise<string | null> {
	const provider = parseWhatsAppProvider(flags.provider)
	const defaultAuthDir = provider === 'baileys' ? DEFAULT_BAILEYS_AUTH_DIR : DEFAULT_AUTH_DIR
	const authDir = expandHome(flags.auth ?? defaultAuthDir)
	await initLogger(flags.debug ? 'debug' : 'info')

	const client = new WhatsAppClient({
		authDir,
		provider,
		onIncoming: async () => undefined,
	})

	try {
		await client.start()
		const connected = await waitForClientConnection(client)
		if (!connected) return null
		const result = direction === 'to-pn' ? await client.lookupPnByLid(value) : await client.lookupLidByPn(value)
		if (result) {
			const store = await createStore()
			if (direction === 'to-pn') {
				await store.set(value, result)
			} else {
				await store.set(result, value)
			}
		}
		return result
	} catch {
		return null
	} finally {
		await client.stop().catch(() => undefined)
	}
}

export const toolCmd = app.sub('tool')
	.meta({ description: 'Utility conversions for WhatsApp identifiers' })
	.command(
		app
			.sub('to-pn')
			.meta({ description: 'Convert WhatsApp LID (or LID-like input) to phone number' })
			.args([{ name: 'lid', type: 'string', required: true }])
			.run(async ({ args, flags }) => {
				const store = await createStore()
				const pn = store.get(args.lid)
					?? await lookupViaDaemon(flags, 'to-pn', args.lid)
					?? await lookupViaWhatsApp(flags, 'to-pn', args.lid)
				if (!pn) {
					console.error('❌ mapping not found')
					process.exit(1)
				}

				if (flags.json) {
					console.log(JSON.stringify({ ok: true, input: args.lid, pn }, null, 2))
					return
				}

				console.log(pn)
			}),
	)
	.command(
		app
			.sub('to-lid')
			.meta({ description: 'Convert phone number / PN JID to WhatsApp LID using local map' })
			.args([{ name: 'pn', type: 'string', required: true }])
			.run(async ({ args, flags }) => {
				const store = await createStore()
				const lid = store.getLidByPn(args.pn)
					?? await lookupViaDaemon(flags, 'to-lid', args.pn)
					?? await lookupViaWhatsApp(flags, 'to-lid', args.pn)
				if (!lid) {
					console.error('❌ mapping not found')
					process.exit(1)
				}

				if (flags.json) {
					console.log(JSON.stringify({ ok: true, input: args.pn, lid }, null, 2))
					return
				}

				console.log(lid)
			}),
	)
