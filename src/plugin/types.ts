import type { z } from 'zod'
import type { IncomingDmMessage, IncomingGroupMessage } from '../types.ts'
import type { OutgoingMessageKey, SendTextOptions, WhatsAppProvider } from '../whatsapp/types.ts'

export type MaybePromise<T> = T | Promise<T>
export type RawPluginArgs = Readonly<Record<string, string>>

export type PluginRuntimeReason =
	| 'manual-disable'
	| 'daemon-shutdown'
	| 'reload'
	| 'error-threshold'

export type KotaetePluginIncomingEvent = {
	message: IncomingGroupMessage
	receivedAt: Date
}

export type KotaetePluginDmEvent = {
	message: IncomingDmMessage
	receivedAt: Date
}

export type KotaetePluginConnectedEvent = {
	provider: WhatsAppProvider
	connectedAt: Date
}

export interface KotaetePluginHooks {
	onWaConnected?(event: KotaetePluginConnectedEvent): MaybePromise<void>
	onIncomingMessage?(event: KotaetePluginIncomingEvent): MaybePromise<void>
	onIncomingDmMessage?(event: KotaetePluginDmEvent): MaybePromise<void>
	teardown?(reason: PluginRuntimeReason): MaybePromise<void>
}

export interface KotaetePluginContext {
	readonly pluginName: string
	readonly sourcePath: string

	sendText(
		groupId: string,
		text: string,
		opts?: SendTextOptions & { typing?: boolean },
	): Promise<OutgoingMessageKey | null>
	sendImageWithCaption(
		groupId: string,
		imagePath: string,
		caption: string,
		opts?: { typing?: boolean },
	): Promise<OutgoingMessageKey | null>
	sendTyping(groupId: string): Promise<void>
	sendDmText(
		senderJid: string,
		text: string,
		opts?: SendTextOptions,
	): Promise<OutgoingMessageKey | null>
	react(groupId: string, key: IncomingGroupMessage['key'], emoji: string): Promise<void>
	reactDm(senderJid: string, key: IncomingDmMessage['key'], emoji: string): Promise<void>

	getOwnJid(): string | null

	lookupPnByLid(lid: string): Promise<string | null>
	lookupLidByPn(pn: string): Promise<string | null>

	isConnected(): Promise<boolean>

	log: {
		debug(msg: string): void
		info(msg: string): void
		warn(msg: string): void
		error(msg: string): void
	}
	isQuizRunning(groupId: string): Promise<boolean>
}

type InferPluginArgs<TSchema extends z.ZodTypeAny | undefined> = TSchema extends z.ZodTypeAny ? z.infer<TSchema>
	: RawPluginArgs

export interface KotaetePluginDefinition<TSchema extends z.ZodTypeAny | undefined = undefined> {
	name: string
	version?: string
	description?: string
	argsSchema?: TSchema
	hookTimeoutMs?: number
	setup(
		ctx: KotaetePluginContext,
		args: InferPluginArgs<TSchema>,
	): MaybePromise<KotaetePluginHooks | void>
}

/** Shape of a plugin module's default export after dynamic import */
export type PluginModule = {
	default: KotaetePluginDefinition
}

/** Runtime entry tracking an active plugin */
export type ActivePluginEntry = {
	name: string
	sourcePath: string
	args: Record<string, string>
	hooks: KotaetePluginHooks
	enabledAt: Date
	consecutiveErrors: number
	hookTimeoutMs: number
}
