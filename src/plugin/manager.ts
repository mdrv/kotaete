import type { ZodTypeAny } from 'zod'
import { getLogger } from '../logger.ts'
import type { IncomingDmMessage, IncomingGroupMessage } from '../types.ts'
import type { OutgoingMessageKey, SendTextOptions, WhatsAppProvider } from '../whatsapp/types.ts'
import { loadPlugin } from './loader.ts'
import { PluginStore } from './store.ts'
import type {
	ActivePluginEntry,
	KotaetePluginConnectedEvent,
	KotaetePluginContext,
	KotaetePluginDefinition,
	KotaetePluginDmEvent,
	KotaetePluginHooks,
	KotaetePluginIncomingEvent,
	PluginRuntimeReason,
} from './types.ts'

const log = getLogger(['kotaete', 'plugin'])

/** Max consecutive hook failures before auto-disabling a plugin */
const MAX_CONSECUTIVE_ERRORS = 5

export type PluginManagerDeps = {
	sendText(groupId: string, text: string, opts?: SendTextOptions): Promise<OutgoingMessageKey | null>
	sendImageWithCaption(
		groupId: string,
		imagePath: string,
		caption: string,
	): Promise<OutgoingMessageKey | null>
	sendTyping(groupId: string): Promise<void>
	react(groupId: string, key: IncomingGroupMessage['key'], emoji: string): Promise<void>
	reactDm(senderJid: string, key: IncomingDmMessage['key'], emoji: string): Promise<void>
	sendDmText(senderJid: string, text: string, opts?: SendTextOptions): Promise<OutgoingMessageKey | null>
	lookupPnByLid(lid: string): Promise<string | null>
	lookupLidByPn(pn: string): Promise<string | null>
	isConnected(): Promise<boolean>
	getProvider(): WhatsAppProvider
	getOwnJid(): string | null
	isQuizRunning(groupId: string): Promise<boolean>
}

export type PluginListEntry = {
	name: string
	sourcePath: string
	args: Record<string, string>
	enabledAt: string
	active: boolean
	lastError: { at: string; message: string } | undefined
}

export class PluginManager {
	private readonly deps: PluginManagerDeps
	private readonly store: PluginStore
	private readonly activePlugins = new Map<string, ActivePluginEntry>()

	constructor(deps: PluginManagerDeps, store?: PluginStore) {
		this.deps = deps
		this.store = store ?? new PluginStore()
	}

	async init(): Promise<void> {
		await this.store.load()
	}

	// ---------------------------------------------------------------------------
	// Enable / disable
	// ---------------------------------------------------------------------------

	async enable(sourcePath: string, args: Record<string, string>): Promise<string> {
		const definition = await loadPlugin(sourcePath, { reload: false })
		const name = definition.name

		// If already active, disable first (reload)
		if (this.activePlugins.has(name)) {
			await this.disableInternal(name, 'reload')
		}

		const hooks = await this.setupPlugin(definition, sourcePath, args)

		const entry: ActivePluginEntry = {
			name,
			sourcePath,
			args,
			hooks,
			enabledAt: new Date(),
			consecutiveErrors: 0,
			hookTimeoutMs: getValidTimeoutMs(definition.hookTimeoutMs),
		}
		this.activePlugins.set(name, entry)

		// Persist
		await this.store.add({
			name,
			sourcePath,
			args,
			enabledAt: entry.enabledAt.toISOString(),
		})

		log.info(`plugin "${name}" enabled from ${sourcePath}`)
		return name
	}

	async disable(name: string): Promise<void> {
		await this.disableInternal(name, 'manual-disable')
	}

	async disableInternal(name: string, reason: PluginRuntimeReason): Promise<void> {
		const entry = this.activePlugins.get(name)
		if (!entry) return

		await this.safeTeardown(entry, reason)
		this.activePlugins.delete(name)

		await this.store.remove(name)
		log.info(`plugin "${name}" disabled (reason: ${reason})`)
	}

	list(): PluginListEntry[] {
		const manifestEntries = this.store.entries
		return manifestEntries.map((entry) => {
			const active = this.activePlugins.get(entry.name)
			return {
				name: entry.name,
				sourcePath: entry.sourcePath,
				args: entry.args,
				enabledAt: entry.enabledAt,
				active: active !== undefined,
				lastError: undefined,
			}
		})
	}

	// ---------------------------------------------------------------------------
	// Event emission (fire-and-forget, non-blocking to daemon pipeline)
	// ---------------------------------------------------------------------------

	emitIncoming(message: IncomingGroupMessage): void {
		const event: KotaetePluginIncomingEvent = {
			message,
			receivedAt: new Date(),
		}
		for (const entry of this.activePlugins.values()) {
			if (!entry.hooks.onIncomingMessage) continue
			void this.invokeHook(entry, 'onIncomingMessage', event)
		}
	}

	emitIncomingDm(message: IncomingDmMessage): void {
		const event: KotaetePluginDmEvent = {
			message,
			receivedAt: new Date(),
		}
		for (const entry of this.activePlugins.values()) {
			if (!entry.hooks.onIncomingDmMessage) continue
			void this.invokeHook(entry, 'onIncomingDmMessage', event)
		}
	}

	emitWaConnected(): void {
		const event: KotaetePluginConnectedEvent = {
			provider: this.deps.getProvider(),
			connectedAt: new Date(),
		}
		for (const entry of this.activePlugins.values()) {
			if (!entry.hooks.onWaConnected) continue
			void this.invokeHook(entry, 'onWaConnected', event)
		}
	}

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------

	async restoreFromManifest(): Promise<void> {
		const entries = this.store.entries
		for (const entry of entries) {
			try {
				await this.enable(entry.sourcePath, entry.args)
				log.info(`restored plugin "${entry.name}" from manifest`)
			} catch (error) {
				log.error(
					`failed to restore plugin "${entry.name}" from ${entry.sourcePath}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
				// Remove from manifest so it doesn't persist as broken
				await this.store.remove(entry.name)
			}
		}
	}

	async shutdown(): Promise<void> {
		const names = [...this.activePlugins.keys()]
		for (const name of names) {
			await this.disableInternal(name, 'daemon-shutdown')
		}
	}

	// ---------------------------------------------------------------------------
	// Internals
	// ---------------------------------------------------------------------------

	private createPluginContext(pluginName: string, sourcePath: string): KotaetePluginContext {
		const pluginLog = getLogger(['kotaete', 'plugin', pluginName])
		return {
			pluginName,
			sourcePath,

			sendText: (groupId, text, opts) => this.deps.sendText(groupId, text, opts),
			sendImageWithCaption: (groupId, imagePath, caption, opts) => {
				if (opts?.typing) {
					return this.deps.sendImageWithCaption(groupId, imagePath, caption)
				}
				return this.deps.sendImageWithCaption(groupId, imagePath, caption)
			},
			sendTyping: (groupId) => this.deps.sendTyping(groupId),
			sendDmText: (senderJid, text, opts) => this.deps.sendDmText(senderJid, text, opts),
			react: (groupId, key, emoji) => this.deps.react(groupId, key, emoji),
			reactDm: (senderJid, key, emoji) => this.deps.reactDm(senderJid, key, emoji),

			lookupPnByLid: (lid) => this.deps.lookupPnByLid(lid),
			lookupLidByPn: (pn) => this.deps.lookupLidByPn(pn),

			isConnected: () => this.deps.isConnected(),
			getOwnJid: () => this.deps.getOwnJid(),
			isQuizRunning: (groupId) => this.deps.isQuizRunning(groupId),
			log: {
				debug: (msg) => pluginLog.debug(msg),
				info: (msg) => pluginLog.info(msg),
				warn: (msg) => pluginLog.warn(msg),
				error: (msg) => pluginLog.error(msg),
			},
		}
	}

	private async setupPlugin(
		definition: KotaetePluginDefinition,
		sourcePath: string,
		args: Record<string, string>,
	): Promise<KotaetePluginHooks> {
		const ctx = this.createPluginContext(definition.name, sourcePath)

		// If the plugin has an argsSchema, validate and parse args
		let parsedArgs: Record<string, string> = args
		const schema = definition.argsSchema as ZodTypeAny | undefined
		if (schema) {
			const validated = schema.safeParse(args)
			if (!validated.success) {
				throw new Error(
					`invalid args for plugin "${definition.name}": ${
						validated.error.issues.map((issue: { message: string }) => issue.message).join(', ')
					}`,
				)
			}
			parsedArgs = validated.data as Record<string, string>
		}

		const result = await definition.setup(ctx, parsedArgs)
		return result ?? {}
	}

	private async invokeHook<K extends keyof KotaetePluginHooks>(
		entry: ActivePluginEntry,
		hookName: K,
		...args: Parameters<NonNullable<KotaetePluginHooks[K]>>
	): Promise<void> {
		const hook = entry.hooks[hookName]
		if (!hook) return

		try {
			await withTimeout(
				(hook as (...a: unknown[]) => unknown)(...args),
				entry.hookTimeoutMs,
				`plugin "${entry.name}" hook ${hookName} timed out`,
			)
			entry.consecutiveErrors = 0
		} catch (error) {
			entry.consecutiveErrors++
			log.error(
				`plugin "${entry.name}" hook ${hookName} failed (${entry.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${
					error instanceof Error ? error.message : String(error)
				}`,
			)

			if (entry.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
				log.error(`plugin "${entry.name}" auto-disabled after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`)
				void this.disableInternal(entry.name, 'error-threshold')
			}
		}
	}

	private async safeTeardown(entry: ActivePluginEntry, reason: PluginRuntimeReason): Promise<void> {
		if (!entry.hooks.teardown) return
		try {
			await withTimeout(
				entry.hooks.teardown(reason),
				entry.hookTimeoutMs,
				`plugin "${entry.name}" teardown timed out`,
			)
		} catch (error) {
			log.error(
				`plugin "${entry.name}" teardown error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
}

const DEFAULT_HOOK_TIMEOUT_MS = 5_000

function getValidTimeoutMs(value: number | undefined): number {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
	return DEFAULT_HOOK_TIMEOUT_MS
}
function withTimeout(promise: unknown, ms: number, message: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms)
		Promise.resolve(promise)
			.then(() => {
				clearTimeout(timer)
				resolve()
			})
			.catch((error) => {
				clearTimeout(timer)
				reject(error)
			})
	})
}
