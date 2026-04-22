import { DEFAULT_WHATSAPP_PROVIDER } from '../constants.ts'
import type { IncomingDmMessage, IncomingGroupMessage } from '../types.ts'

export type WhatsAppProvider = 'wwebjs' | 'baileys'

export type BaseWhatsAppClientOptions = {
	authDir: string
	onIncoming: (message: IncomingGroupMessage) => Promise<void>
	onIncomingDm?: (message: IncomingDmMessage) => Promise<void>
}

export type SendTextOptions = {
	linkPreview?: boolean
	quotedKey?: IncomingGroupMessage['key']
}

export type OutgoingMessageKey = IncomingGroupMessage['key']

export interface IWhatsAppClient {
	start(): Promise<void>
	stop(): Promise<void>
	isConnected(): Promise<boolean>
	lookupPnByLid(lid: string): Promise<string | null>
	lookupLidByPn(pn: string): Promise<string | null>
	sendTyping(groupId: string): Promise<void>
	sendText(groupId: string, text: string, opts?: SendTextOptions): Promise<OutgoingMessageKey | null>
	sendImageWithCaption(groupId: string, imagePath: string, caption: string): Promise<OutgoingMessageKey | null>
	react(groupId: string, key: IncomingGroupMessage['key'], emoji: string): Promise<void>
	getOwnJid(): string | null
}

export function parseWhatsAppProvider(input: string | undefined): WhatsAppProvider {
	if (!input) return DEFAULT_WHATSAPP_PROVIDER
	if (input === 'wwebjs' || input === 'baileys') return input
	throw new Error(`[wa] unsupported provider '${input}'. expected one of: wwebjs, baileys`)
}
