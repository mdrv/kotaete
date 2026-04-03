import { getLogger } from '../logger.ts'
import type { IncomingGroupMessage } from '../types.ts'
import { BaileysWhatsAppClient } from './baileys-client.ts'
import {
	type BaseWhatsAppClientOptions,
	type IWhatsAppClient,
	type OutgoingMessageKey,
	parseWhatsAppProvider,
	type SendTextOptions,
	type WhatsAppProvider,
} from './types.ts'
import { WWebJsWhatsAppClient } from './wwebjs-client.ts'

const log = getLogger(['kotaete', 'wa'])

type WhatsAppClientOptions = BaseWhatsAppClientOptions & {
	provider?: string
}

export class WhatsAppClient implements IWhatsAppClient {
	readonly provider: WhatsAppProvider
	private readonly impl: IWhatsAppClient

	constructor(options: WhatsAppClientOptions) {
		this.provider = parseWhatsAppProvider(options.provider)
		const baseOptions: BaseWhatsAppClientOptions = {
			authDir: options.authDir,
			onIncoming: options.onIncoming,
		}

		if (this.provider === 'baileys') {
			log.warning('Using experimental WhatsApp provider: baileys')
			this.impl = new BaileysWhatsAppClient(baseOptions)
			return
		}

		log.info('Using WhatsApp provider: wwebjs (default)')
		this.impl = new WWebJsWhatsAppClient(baseOptions)
	}

	async start(): Promise<void> {
		await this.impl.start()
	}

	async stop(): Promise<void> {
		await this.impl.stop()
	}

	async isConnected(): Promise<boolean> {
		return await this.impl.isConnected()
	}

	async lookupPnByLid(lid: string): Promise<string | null> {
		return await this.impl.lookupPnByLid(lid)
	}

	async lookupLidByPn(pn: string): Promise<string | null> {
		return await this.impl.lookupLidByPn(pn)
	}

	async sendTyping(groupId: string): Promise<void> {
		await this.impl.sendTyping(groupId)
	}

	async sendText(groupId: string, text: string, opts?: SendTextOptions): Promise<OutgoingMessageKey | null> {
		return await this.impl.sendText(groupId, text, opts)
	}

	async sendImageWithCaption(
		groupId: string,
		imagePath: string,
		caption: string,
	): Promise<OutgoingMessageKey | null> {
		return await this.impl.sendImageWithCaption(groupId, imagePath, caption)
	}

	async react(groupId: string, key: IncomingGroupMessage['key'], emoji: string): Promise<void> {
		await this.impl.react(groupId, key, emoji)
	}
}
