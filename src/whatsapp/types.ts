import { DEFAULT_WHATSAPP_PROVIDER } from '../constants.ts'
import type { IncomingGroupMessage } from '../types.ts'

export type WhatsAppProvider = 'wwebjs' | 'baileys'

export type BaseWhatsAppClientOptions = {
	authDir: string
	onIncoming: (message: IncomingGroupMessage) => Promise<void>
}

export type SendTextOptions = {
	linkPreview?: boolean
	quotedKey?: IncomingGroupMessage['key']
}

export interface IWhatsAppClient {
	start(): Promise<void>
	stop(): Promise<void>
	sendTyping(groupId: string): Promise<void>
	sendText(groupId: string, text: string, opts?: SendTextOptions): Promise<void>
	sendImageWithCaption(groupId: string, imagePath: string, caption: string): Promise<void>
	react(groupId: string, key: IncomingGroupMessage['key'], emoji: string): Promise<void>
}

export function parseWhatsAppProvider(input: string | undefined): WhatsAppProvider {
	if (!input) return DEFAULT_WHATSAPP_PROVIDER
	if (input === 'wwebjs' || input === 'baileys') return input
	throw new Error(`[wa] unsupported provider '${input}'. expected one of: wwebjs, baileys`)
}
