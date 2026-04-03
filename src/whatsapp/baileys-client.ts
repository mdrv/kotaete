import { Boom } from '@hapi/boom'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { getLogger } from '../logger.ts'
import type { MessageKeyLike } from '../types.ts'
import { normalizeJidNumber } from '../utils/normalize.ts'
import { LidPnStore } from './lid-pn-store.ts'
import type { BaseWhatsAppClientOptions, IWhatsAppClient, SendTextOptions } from './types.ts'

const log = getLogger(['kotaete', 'wa', 'baileys'])

type BaileysSocketLike = {
	sendMessage: (
		groupId: string,
		content: unknown,
		options?: unknown,
	) => Promise<{ key?: MessageKeyLike } | unknown>
	sendPresenceUpdate?: (state: 'composing' | 'paused', jid: string) => Promise<unknown>
	end: (error?: unknown) => void
	ev: {
		on: (event: string, listener: (...args: unknown[]) => void | Promise<void>) => void
	}
	signalRepository?: {
		lidMapping?: {
			getPNForLID?: (lid: string) => Promise<string | null | undefined>
		}
	}
}

type SenderResolution = {
	number: string | null
	source: 'pn-alt' | 'pn' | 'lid-cache' | 'lid-lookup' | 'unresolved'
}

const INBOUND_DEDUPE_LIMIT = 5_000
const REPLAY_SKEW_SECONDS = 5

export class BaileysWhatsAppClient implements IWhatsAppClient {
	private sock: BaileysSocketLike | null = null
	private stopping = false
	private reconnectAttempts = 0
	private acceptMessagesFromTsSec = 0
	private readonly seenMessageIds = new Set<string>()
	private readonly seenMessageOrder: string[] = []
	private baileysRuntime: {
		makeWASocket: (options: Record<string, unknown>) => BaileysSocketLike
		Browsers: {
			windows: (browser: string) => unknown
		}
		fetchLatestBaileysVersion: () => Promise<{ version: [number, number, number] }>
		isJidGroup: (jid: string) => boolean
		isLidUser: (jid: string) => boolean
		jidNormalizedUser: (jid: string) => string
		makeCacheableSignalKeyStore: (keys: unknown, logger: unknown) => unknown
		useMultiFileAuthState: (
			authDir: string,
		) => Promise<{ state: { creds: unknown; keys: unknown }; saveCreds: () => Promise<void> | void }>
		DisconnectReason: {
			loggedOut: number
		}
	} | null = null

	constructor(
		private readonly options: BaseWhatsAppClientOptions,
		private readonly lidPnStore: LidPnStore = new LidPnStore(),
	) {}

	private async getRuntime() {
		if (this.baileysRuntime) return this.baileysRuntime
		const moduleSpecifier = ['@whiskeysockets', 'baileys/lib/index.js'].join('/')
		const dynamicImport = Function('specifier', 'return import(specifier)') as (
			specifier: string,
		) => Promise<unknown>
		const runtime = (await dynamicImport(moduleSpecifier)) as {
			default: (options: Record<string, unknown>) => BaileysSocketLike
			Browsers: {
				windows: (browser: string) => unknown
			}
			fetchLatestBaileysVersion: () => Promise<{ version: [number, number, number] }>
			isJidGroup: (jid: string) => boolean
			isLidUser: (jid: string) => boolean
			jidNormalizedUser: (jid: string) => string
			makeCacheableSignalKeyStore: (keys: unknown, logger: unknown) => unknown
			useMultiFileAuthState: (
				authDir: string,
			) => Promise<{ state: { creds: unknown; keys: unknown }; saveCreds: () => Promise<void> | void }>
			DisconnectReason: {
				loggedOut: number
			}
		}

		this.baileysRuntime = {
			makeWASocket: runtime.default,
			Browsers: runtime.Browsers,
			fetchLatestBaileysVersion: runtime.fetchLatestBaileysVersion,
			isJidGroup: runtime.isJidGroup,
			isLidUser: runtime.isLidUser,
			jidNormalizedUser: runtime.jidNormalizedUser,
			makeCacheableSignalKeyStore: runtime.makeCacheableSignalKeyStore,
			useMultiFileAuthState: runtime.useMultiFileAuthState,
			DisconnectReason: runtime.DisconnectReason,
		}

		return this.baileysRuntime
	}

	async start(): Promise<void> {
		this.stopping = false
		await this.lidPnStore.load()
		log.warning('Starting Baileys provider (experimental)')
		const runtime = await this.getRuntime()
		const { state, saveCreds } = await runtime.useMultiFileAuthState(this.options.authDir)
		const versionInfo = await runtime.fetchLatestBaileysVersion()
		const logger = pino({ level: 'silent' })

		this.sock = runtime.makeWASocket({
			auth: {
				creds: state.creds,
				keys: runtime.makeCacheableSignalKeyStore(state.keys, logger),
			},
			version: versionInfo.version,
			browser: runtime.Browsers.windows('Chrome'),
			logger,
			markOnlineOnConnect: false,
			syncFullHistory: true,
		})

		this.sock.ev.on('creds.update', saveCreds)
		this.sock.ev.on('lid-mapping.update', (...args) => {
			const payload = args[0] as { lid?: string; pn?: string } | undefined
			if (!payload?.lid || !payload.pn) return
			void this.lidPnStore.set(payload.lid, payload.pn)
		})

		this.sock.ev.on('messages.upsert', async (...args) => {
			const evt = args[0] as
				| {
					type?: string
					messages?: Array<{
						message?: { conversation?: string; extendedTextMessage?: { text?: string } }
						messageTimestamp?: unknown
						key: {
							fromMe?: boolean | null
							remoteJid?: string | null
							participant?: string | null
							participantAlt?: string | null
							remoteJidAlt?: string | null
							id?: string | null
						}
					}>
				}
				| undefined
			if (!evt) return
			if (evt.type !== 'notify') return
			for (const message of evt.messages ?? []) {
				if (!message.message || message.key.fromMe) continue
				if (this.isDuplicateMessage(message.key.id ?? null)) {
					log.debug(`baileys drop duplicate id=${message.key.id ?? 'null'}`)
					continue
				}
				const messageTimestamp = this.normalizeTimestampSeconds(message.messageTimestamp)
				if (this.acceptMessagesFromTsSec > 0 && messageTimestamp !== null) {
					if (messageTimestamp < this.acceptMessagesFromTsSec) {
						log.debug(
							`baileys drop replay id=${
								message.key.id ?? 'null'
							} ts=${messageTimestamp} cutoff=${this.acceptMessagesFromTsSec}`,
						)
						continue
					}
				}
				const groupId = message.key.remoteJid
				if (!groupId || !runtime.isJidGroup(groupId)) continue
				const text = message.message.conversation ?? message.message.extendedTextMessage?.text ?? ''
				const senderRawJid = message.key.participant ?? ''
				if (!text.trim() || !senderRawJid) continue
				const senderAltJid = message.key.participantAlt ?? message.key.remoteJidAlt ?? null
				const resolution = await this.resolveSenderNumber(senderRawJid, senderAltJid)
				log.debug(
					`baileys inbound message group=${groupId} sender=${senderRawJid} senderNumber=${
						resolution.number ?? 'null'
					} source=${resolution.source} len=${text.length}`,
				)

				await this.options.onIncoming({
					groupId,
					senderRawJid,
					senderNumber: resolution.number,
					text,
					key: {
						remoteJid: message.key.remoteJid ?? null,
						participant: message.key.participant ?? null,
						id: message.key.id ?? null,
						fromMe: message.key.fromMe ?? null,
					},
				})
			}
		})

		this.sock.ev.on('connection.update', async (...args) => {
			const update = args[0] as { connection?: string; lastDisconnect?: { error?: Boom }; qr?: string } | undefined
			if (!update) return
			const { connection, lastDisconnect, qr } = update
			if (qr) {
				qrcode.generate(qr, { small: true })
				log.info('Scan QR from WhatsApp linked devices screen to authenticate daemon')
			}
			if (connection === 'open') {
				this.reconnectAttempts = 0
				this.acceptMessagesFromTsSec = Math.floor(Date.now() / 1000) - REPLAY_SKEW_SECONDS
				log.info('Baileys connected')
				log.debug(`baileys inbound cutoff set ts=${this.acceptMessagesFromTsSec}`)
				return
			}
			if (connection !== 'close' || this.stopping) return
			const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
			const loggedOut = code === runtime.DisconnectReason.loggedOut
			if (loggedOut) {
				log.error('Baileys session logged out. Re-authentication required.')
				return
			}

			this.reconnectAttempts += 1
			const delay = Math.min(1000 * 2 ** Math.min(this.reconnectAttempts, 5), 30_000)
			log.warning(`Baileys disconnected (code=${code ?? 'unknown'}). Reconnecting in ${delay}ms`)
			await Bun.sleep(delay)
			if (!this.stopping) await this.start()
		})
	}

	async stop(): Promise<void> {
		this.stopping = true
		this.sock?.end(undefined)
		this.sock = null
	}

	async sendTyping(groupId: string): Promise<void> {
		if (!this.sock?.sendPresenceUpdate) return
		await this.sock.sendPresenceUpdate('composing', groupId)
	}

	private async resolveSenderNumber(senderRawJid: string, senderAltJid: string | null): Promise<SenderResolution> {
		const runtime = await this.getRuntime()
		const fromAlt = senderAltJid ? normalizeJidNumber(senderAltJid) : null
		if (fromAlt) return { number: fromAlt, source: 'pn-alt' }

		const normalizedRawJid = runtime.jidNormalizedUser(senderRawJid)
		const fromRaw = normalizeJidNumber(normalizedRawJid)
		if (!runtime.isLidUser(normalizedRawJid)) {
			return { number: fromRaw, source: fromRaw ? 'pn' : 'unresolved' }
		}

		const mappedPn = this.lidPnStore.get(normalizedRawJid)
		if (mappedPn) {
			const fromMapped = normalizeJidNumber(mappedPn)
			if (fromMapped) return { number: fromMapped, source: 'lid-cache' }
		}

		const resolvedPn = await this.sock?.signalRepository?.lidMapping?.getPNForLID?.(normalizedRawJid)
		if (resolvedPn) {
			await this.lidPnStore.set(normalizedRawJid, resolvedPn)
			const fromResolved = normalizeJidNumber(resolvedPn)
			if (fromResolved) return { number: fromResolved, source: 'lid-lookup' }
		}

		return { number: null, source: 'unresolved' }
	}

	private normalizeTimestampSeconds(value: unknown): number | null {
		if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
		if (typeof value === 'string') {
			const asNumber = Number(value)
			if (Number.isFinite(asNumber)) return Math.floor(asNumber)
			return null
		}
		if (value && typeof value === 'object' && 'toString' in value && typeof value.toString === 'function') {
			const asNumber = Number(value.toString())
			if (Number.isFinite(asNumber)) return Math.floor(asNumber)
		}
		return null
	}

	private isDuplicateMessage(messageId: string | null | undefined): boolean {
		if (!messageId) return false
		if (this.seenMessageIds.has(messageId)) return true
		this.seenMessageIds.add(messageId)
		this.seenMessageOrder.push(messageId)
		if (this.seenMessageOrder.length > INBOUND_DEDUPE_LIMIT) {
			const oldest = this.seenMessageOrder.shift()
			if (oldest) this.seenMessageIds.delete(oldest)
		}
		return false
	}

	async sendText(groupId: string, text: string, opts?: SendTextOptions): Promise<MessageKeyLike | null> {
		if (!this.sock) throw new Error('[wa:baileys] socket is not initialized')
		const quoted = opts?.quotedKey?.id && opts?.quotedKey?.remoteJid
			? {
				key: {
					id: opts.quotedKey.id,
					remoteJid: opts.quotedKey.remoteJid,
					participant: opts.quotedKey.participant ?? null,
					fromMe: opts.quotedKey.fromMe ?? false,
				},
			}
			: undefined
		const sent = await this.sock.sendMessage(groupId, { text }, quoted)
		return this.extractSentMessageKey(sent, groupId)
	}

	async sendImageWithCaption(groupId: string, imagePath: string, caption: string): Promise<MessageKeyLike | null> {
		if (!this.sock) throw new Error('[wa:baileys] socket is not initialized')
		const sent = await this.sock.sendMessage(groupId, {
			image: { url: imagePath },
			caption,
		})
		return this.extractSentMessageKey(sent, groupId)
	}

	private extractSentMessageKey(payload: unknown, groupId: string): MessageKeyLike | null {
		if (!payload || typeof payload !== 'object') return null
		const key = (payload as { key?: MessageKeyLike }).key
		if (!key || !key.id) return null
		return {
			remoteJid: key.remoteJid ?? groupId,
			participant: key.participant ?? null,
			id: key.id,
			fromMe: key.fromMe ?? true,
		}
	}

	async react(
		groupId: string,
		key: { remoteJid?: string | null; participant?: string | null; id?: string | null },
		emoji: string,
	): Promise<void> {
		if (!this.sock) throw new Error('[wa:baileys] socket is not initialized')
		if (!key.id || !key.remoteJid) return
		await this.sock.sendMessage(groupId, {
			react: {
				text: emoji,
				key: {
					id: key.id,
					remoteJid: key.remoteJid,
					participant: key.participant ?? null,
					fromMe: false,
				},
			},
		})
	}
}
