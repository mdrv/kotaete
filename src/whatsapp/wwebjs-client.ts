import { EventEmitter } from 'node:events'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import qrcode from 'qrcode-terminal'
import { Client, type ClientOptions, LocalAuth, type Message, MessageMedia, type WAState } from 'whatsapp-web.js'
import { getLogger } from '../logger.ts'
import { normalizeJidNumber } from '../utils/normalize.ts'
import { LidPnStore } from './lid-pn-store.ts'
import type { BaseWhatsAppClientOptions, IWhatsAppClient, OutgoingMessageKey, SendTextOptions } from './types.ts'

const log = getLogger(['kotaete', 'wa', 'wwebjs'])

type WWebJsClientLike = EventEmitter & {
	initialize(): Promise<void>
	destroy(): Promise<void>
	getState(): Promise<WAState | string>
	getChatById(chatId: string): Promise<{ sendStateTyping: () => Promise<void> }>
	sendMessage(chatId: string, content: unknown, options?: unknown): Promise<{ id?: { _serialized?: string } } | unknown>
	getMessageById(messageId: string): Promise<{ react: (emoji: string) => Promise<void> }>
	getContactLidAndPhone?: (userIds: string[]) => Promise<Array<{ lid?: string; pn?: string }>>
}

type WWebJsMessageLike = Pick<Message, 'from' | 'author' | 'body' | 'fromMe'> & {
	id: { _serialized: string }
	timestamp?: number
}

type WWebJsDeps = {
	createClient: (authDir: string) => WWebJsClientLike
	messageMediaFromFilePath: (path: string) => unknown
	generateQr: (qr: string) => void
	nowMs: () => number
}

type LidPnStorePort = {
	load(): Promise<void>
	entriesCount(): number
	get(lidRaw: string): string | null
	getLidByPn(pnRaw: string): string | null
	set(lidRaw: string, pnRaw: string): Promise<boolean>
}

type SenderResolution = {
	number: string | null
	source: 'pn' | 'lid-cache' | 'lid-lookup' | 'unresolved'
}

type ExecutablePathResolverDeps = {
	env: Record<string, string | undefined>
	homeDir: string
	existsPath: (path: string) => boolean
	listDirectoryNames: (path: string) => string[]
}

const PLAYWRIGHT_CHROMIUM_CANDIDATES = [
	'chrome-linux/chrome',
	'chrome-linux-arm64/chrome',
	'chrome-win/chrome.exe',
	'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
]

function normalizeExecutableEnv(raw: string | undefined): string | null {
	const value = raw?.trim()
	return value ? value : null
}

function parseChromiumRevision(dirName: string): number {
	const match = dirName.match(/^chromium-(\d+)$/)
	return match?.[1] ? Number.parseInt(match[1], 10) : -1
}

function resolveBrowserExecutablePath(
	deps: ExecutablePathResolverDeps = {
		env: process.env,
		homeDir: homedir(),
		existsPath: (path) => existsSync(path),
		listDirectoryNames: (path) => {
			try {
				return readdirSync(path, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name)
			} catch {
				return []
			}
		},
	},
): string | null {
	const configuredPuppeteer = normalizeExecutableEnv(deps.env.KOTAETE_PUPPETEER_EXECUTABLE_PATH)
	if (configuredPuppeteer) return configuredPuppeteer

	const configuredPlaywright = normalizeExecutableEnv(deps.env.KOTAETE_PLAYWRIGHT_EXECUTABLE_PATH)
	if (configuredPlaywright) return configuredPlaywright

	const playwrightCacheDir = join(deps.homeDir, '.cache', 'ms-playwright')
	const chromiumDirs = deps.listDirectoryNames(playwrightCacheDir)
		.filter((dirName) => parseChromiumRevision(dirName) >= 0)
		.sort((a, b) => parseChromiumRevision(b) - parseChromiumRevision(a))

	for (const chromiumDir of chromiumDirs) {
		for (const candidate of PLAYWRIGHT_CHROMIUM_CANDIDATES) {
			const executablePath = join(playwrightCacheDir, chromiumDir, candidate)
			if (deps.existsPath(executablePath)) {
				return executablePath
			}
		}
	}

	return null
}

function createClientOptions(authDir: string): ClientOptions {
	const executablePath = resolveBrowserExecutablePath()
	const options: ClientOptions = {
		authStrategy: new LocalAuth({
			clientId: 'kotaete',
			dataPath: authDir,
		}),
		puppeteer: {
			headless: true,
			args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
		},
	}

	if (executablePath) {
		options.puppeteer = {
			...options.puppeteer,
			executablePath,
		}
	}

	return options
}

const defaultDeps: WWebJsDeps = {
	createClient: (authDir) => new Client(createClientOptions(authDir)) as WWebJsClientLike,
	messageMediaFromFilePath: (path) => MessageMedia.fromFilePath(path),
	generateQr: (qr) => {
		qrcode.generate(qr, { small: true })
	},
	nowMs: () => Date.now(),
}

const LID_SUFFIX = '@lid'
const INBOUND_DEDUPE_LIMIT = 5_000
const REPLAY_SKEW_SECONDS = 5
const LOOKUP_WAIT_TIMEOUT_MS = 30_000
const LOOKUP_WAIT_POLL_INTERVAL_MS = 200

function normalizeLidJid(raw: string): string | null {
	const value = raw.trim().replace(/^whatsapp:/, '')
	if (!value) return null
	const [userPart] = value.split('@')
	const user = (userPart ?? '').split(':')[0]?.trim() ?? ''
	if (!user) return null
	return `${user}@lid`
}

export class WWebJsWhatsAppClient implements IWhatsAppClient {
	private client: WWebJsClientLike | null = null
	private stopping = false
	private reconnectAttempts = 0
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private generation = 0
	private acceptMessagesFromTsSec = 0
	private ready = false
	private readonly seenMessageIds = new Set<string>()
	private readonly seenMessageOrder: string[] = []

	constructor(
		private readonly options: BaseWhatsAppClientOptions,
		private readonly deps: WWebJsDeps = defaultDeps,
		private readonly lidPnStore: LidPnStorePort = new LidPnStore(),
	) {}

	async start(): Promise<void> {
		this.stopping = false
		await this.lidPnStore.load()
		log.debug(`wwebjs mapping cache loaded entries=${this.lidPnStore.entriesCount()}`)
		await this.recreateClient('initial-start')
	}

	async stop(): Promise<void> {
		this.stopping = true
		this.ready = false
		this.generation += 1
		this.clearReconnectTimer()
		if (!this.client) return
		const current = this.client
		this.client = null
		await current.destroy().catch((error) => {
			log.warning(`wwebjs destroy failed: ${error instanceof Error ? error.message : String(error)}`)
		})
	}

	async sendText(groupId: string, text: string, opts?: SendTextOptions): Promise<OutgoingMessageKey | null> {
		const client = this.requireClient()
		const quotedMessageId = opts?.quotedKey?.id ?? undefined
		const sent = await client.sendMessage(groupId, text, {
			linkPreview: opts?.linkPreview ?? false,
			...(quotedMessageId ? { quotedMessageId } : {}),
		})
		const id = this.extractSentMessageId(sent)
		return id
			? {
				remoteJid: groupId,
				id,
				fromMe: true,
			}
			: null
	}

	async sendTyping(groupId: string): Promise<void> {
		const client = this.requireClient()
		const chat = await client.getChatById(groupId)
		await chat.sendStateTyping()
	}

	async sendImageWithCaption(groupId: string, imagePath: string, caption: string): Promise<OutgoingMessageKey | null> {
		const client = this.requireClient()
		const media = this.deps.messageMediaFromFilePath(imagePath)
		const sent = await client.sendMessage(groupId, media, {
			caption,
		})
		const id = this.extractSentMessageId(sent)
		return id
			? {
				remoteJid: groupId,
				id,
				fromMe: true,
			}
			: null
	}

	async react(_: string, key: { id?: string | null }, emoji: string): Promise<void> {
		if (!key.id) return
		const client = this.requireClient()
		const msg = await client.getMessageById(key.id)
		await msg.react(emoji)
	}

	private requireClient(): WWebJsClientLike {
		if (!this.client) throw new Error('[wa:wwebjs] client is not initialized')
		return this.client
	}

	async isConnected(): Promise<boolean> {
		return this.ready
	}

	async lookupPnByLid(lid: string): Promise<string | null> {
		const lidJid = normalizeLidJid(lid)
		if (!lidJid) return null

		const cached = this.lidPnStore.get(lidJid)
		if (cached) return cached

		await this.waitForLookupReady('lookupPnByLid')
		const client = this.requireClient()
		const fetch = client.getContactLidAndPhone
		if (!fetch) return null

		try {
			log.info(`wwebjs direct lookup lid->pn for ${lidJid}`)
			const mappings = await fetch.call(client, [lidJid])
			const first = mappings[0]
			const pn = normalizeJidNumber(first?.pn ?? '')
			if (!pn) return null
			await this.lidPnStore.set(first?.lid ?? lidJid, pn)
			return pn
		} catch (error) {
			log.warning(`wwebjs direct lid->pn lookup failed: ${error instanceof Error ? error.message : String(error)}`)
			return null
		}
	}

	async lookupLidByPn(pn: string): Promise<string | null> {
		const cached = this.lidPnStore.getLidByPn(pn)
		if (cached) return cached

		const normalizedPn = normalizeJidNumber(pn)
		if (!normalizedPn) return null

		await this.waitForLookupReady('lookupLidByPn')
		const client = this.requireClient()
		const fetch = client.getContactLidAndPhone
		if (!fetch) return null

		try {
			log.info(`wwebjs direct lookup pn->lid for ${normalizedPn}`)
			const candidates = [`${normalizedPn}@s.whatsapp.net`, `${normalizedPn}@c.us`, normalizedPn]
			for (const candidate of candidates) {
				const mappings = await fetch.call(client, [candidate])
				for (const mapping of mappings) {
					const lid = normalizeLidJid(mapping?.lid ?? '')
					const mappedPn = normalizeJidNumber(mapping?.pn ?? '')
					if (!lid || mappedPn !== normalizedPn) continue
					await this.lidPnStore.set(lid, mappedPn)
					return lid
				}
			}
			log.warning(
				'wwebjs pn->lid direct lookup returned no usable mapping; try provider=baileys for guaranteed support',
			)
			return null
		} catch (error) {
			log.warning(`wwebjs direct pn->lid lookup failed: ${error instanceof Error ? error.message : String(error)}`)
			return null
		}
	}

	private async recreateClient(reason: string): Promise<void> {
		if (this.stopping) return
		this.generation += 1
		const generation = this.generation
		const previous = this.client
		if (previous) {
			this.client = null
			await previous.destroy().catch((error) => {
				log.warning(`wwebjs pre-recreate destroy failed: ${error instanceof Error ? error.message : String(error)}`)
			})
		}

		const client = this.deps.createClient(this.options.authDir)
		this.client = client
		this.bindEvents(client, generation)
		log.debug(`wwebjs initialize requested (${reason}, generation=${generation})`)
		await client.initialize()
	}

	private bindEvents(client: WWebJsClientLike, generation: number): void {
		client.on('qr', (qr: string) => {
			if (!this.isCurrentGeneration(client, generation)) return
			log.info('wwebjs QR received')
			this.deps.generateQr(qr)
		})

		client.on('authenticated', () => {
			if (!this.isCurrentGeneration(client, generation)) return
			log.info('wwebjs authenticated')
		})

		client.on('auth_failure', (message: string) => {
			if (!this.isCurrentGeneration(client, generation)) return
			log.error(`wwebjs auth failure: ${message}`)
		})

		client.on('change_state', async (state: WAState | string) => {
			if (!this.isCurrentGeneration(client, generation)) return
			if (this.stopping) return
			let actualState = state
			try {
				actualState = await client.getState()
			} catch {
				// keep event state
			}
			if (!this.isCurrentGeneration(client, generation)) return
			log.info(`wwebjs state changed: ${actualState}`)
		})

		client.on('ready', () => {
			if (!this.isCurrentGeneration(client, generation)) return
			if (this.stopping) return
			this.ready = true
			this.reconnectAttempts = 0
			this.acceptMessagesFromTsSec = Math.floor(this.deps.nowMs() / 1000) - REPLAY_SKEW_SECONDS
			log.info('wwebjs client is ready')
			log.debug(`wwebjs inbound cutoff set ts=${this.acceptMessagesFromTsSec}`)
		})

		client.on('disconnected', (reason: string) => {
			if (!this.isCurrentGeneration(client, generation)) return
			this.ready = false
			log.warning(`wwebjs disconnected: ${reason}`)
			if (this.stopping) return
			this.scheduleReconnect()
		})

		client.on('message', (message: WWebJsMessageLike) => {
			if (!this.isCurrentGeneration(client, generation)) return
			void this.handleIncomingMessage(message)
		})
	}

	private isCurrentGeneration(client: WWebJsClientLike, generation: number): boolean {
		const isCurrent = this.client === client && this.generation === generation
		if (!isCurrent) {
			log.debug(`wwebjs ignored stale event generation=${generation} current=${this.generation}`)
		}
		return isCurrent
	}

	private async handleIncomingMessage(message: WWebJsMessageLike): Promise<void> {
		if (!this.client || this.stopping) return
		if (message.fromMe) return

		if (this.isDuplicateMessage(message.id._serialized)) {
			log.debug(`wwebjs drop duplicate id=${message.id._serialized}`)
			return
		}

		if (this.acceptMessagesFromTsSec > 0 && typeof message.timestamp === 'number') {
			if (message.timestamp < this.acceptMessagesFromTsSec) {
				log.debug(
					`wwebjs drop replay id=${message.id._serialized} ts=${message.timestamp} cutoff=${this.acceptMessagesFromTsSec}`,
				)
				return
			}
		}

		const text = message.body?.trim() ?? ''
		if (!text) return

		if (message.from.endsWith('@g.us')) {
			// Group message
			const senderRawJid = message.author ?? message.from
			const resolution = await this.resolveSenderNumber(senderRawJid)

			log.debug(
				`wwebjs inbound message group=${message.from} sender=${senderRawJid} senderNumber=${
					resolution.number ?? 'null'
				} source=${resolution.source} len=${text.length}`,
			)

			await this.options.onIncoming({
				groupId: message.from,
				senderRawJid,
				senderNumber: resolution.number,
				senderLid: senderRawJid.endsWith(LID_SUFFIX) ? senderRawJid : null,
				text,
				key: {
					remoteJid: message.from,
					participant: senderRawJid,
					id: message.id._serialized,
					fromMe: message.fromMe,
				},
			})
		} else {
			// DM message
			if (!this.options.onIncomingDm) return
			const senderRawJid = message.from
			const resolution = await this.resolveSenderNumber(senderRawJid)

			log.debug(
				`wwebjs inbound DM sender=${senderRawJid} senderNumber=${
					resolution.number ?? 'null'
				} source=${resolution.source} len=${text.length}`,
			)

			await this.options.onIncomingDm({
				senderJid: senderRawJid,
				senderNumber: resolution.number,
				senderLid: senderRawJid.endsWith(LID_SUFFIX) ? senderRawJid : null,
				text,
				key: {
					remoteJid: senderRawJid,
					participant: null,
					id: message.id._serialized,
					fromMe: message.fromMe,
				},
			})
		}
	}

	private isDuplicateMessage(messageId: string): boolean {
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

	private extractSentMessageId(value: unknown): string | null {
		if (!value || typeof value !== 'object') return null
		const idValue = (value as { id?: unknown }).id
		if (!idValue || typeof idValue !== 'object') return null
		const serialized = (idValue as { _serialized?: unknown })._serialized
		return typeof serialized === 'string' && serialized.length > 0 ? serialized : null
	}

	private async resolveSenderNumber(senderRawJid: string): Promise<SenderResolution> {
		const normalized = normalizeJidNumber(senderRawJid)
		if (!senderRawJid.endsWith(LID_SUFFIX)) {
			return { number: normalized, source: normalized ? 'pn' : 'unresolved' }
		}

		const mapped = this.lidPnStore.get(senderRawJid)
		if (mapped) {
			return { number: mapped, source: 'lid-cache' }
		}

		const client = this.client
		const fetch = client?.getContactLidAndPhone
		if (client && fetch) {
			try {
				const mappings = await fetch.call(client, [senderRawJid])
				const first = mappings[0]
				const resolved = normalizeJidNumber(first?.pn ?? '')
				if (resolved) {
					const lid = first?.lid ?? senderRawJid
					await this.lidPnStore.set(lid, resolved)
					return { number: resolved, source: 'lid-lookup' }
				}
			} catch (error) {
				log.warning(`wwebjs lid lookup failed: ${error instanceof Error ? error.message : String(error)}`)
			}
		}

		return { number: null, source: 'unresolved' }
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return
		this.reconnectAttempts += 1
		const delay = Math.min(1000 * 2 ** Math.min(this.reconnectAttempts, 5), 30_000)
		log.warning(`wwebjs reconnect scheduled in ${delay}ms (attempt=${this.reconnectAttempts})`)
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			if (this.stopping) return
			void this.recreateClient('disconnected-retry').catch((error) => {
				log.error(`wwebjs reconnect failed: ${error instanceof Error ? error.message : String(error)}`)
				if (!this.stopping) this.scheduleReconnect()
			})
		}, delay)
	}

	private clearReconnectTimer(): void {
		if (!this.reconnectTimer) return
		clearTimeout(this.reconnectTimer)
		this.reconnectTimer = null
	}

	private async waitForLookupReady(label: string): Promise<void> {
		if (this.ready && this.client) return
		const deadline = Date.now() + LOOKUP_WAIT_TIMEOUT_MS
		while (Date.now() < deadline) {
			await Bun.sleep(LOOKUP_WAIT_POLL_INTERVAL_MS)
			if (this.ready && this.client) return
		}
		throw new Error(`[wa:wwebjs] ${label}: not connected after ${LOOKUP_WAIT_TIMEOUT_MS}ms`)
	}
}

export const __wwebjsTestInternals = {
	createClientOptions,
	resolveBrowserExecutablePath,
}
