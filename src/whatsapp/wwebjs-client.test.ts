import { describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { BaseWhatsAppClientOptions } from './types.ts'
import { __wwebjsTestInternals, WWebJsWhatsAppClient } from './wwebjs-client.ts'

class FakeClient extends EventEmitter {
	public initialized = 0
	public destroyed = 0
	public sent: Array<{ chatId: string; content: unknown; options: unknown }> = []
	public reactions: Array<{ id: string; emoji: string }> = []
	public typing: string[] = []
	public state: string = 'CONNECTED'
	public lidLookup = mock<(userIds: string[]) => Promise<Array<{ lid?: string; pn?: string }>>>(
		async (_userIds: string[]) => [],
	)

	async initialize(): Promise<void> {
		this.initialized += 1
	}

	async destroy(): Promise<void> {
		this.destroyed += 1
	}

	async getState(): Promise<string> {
		return this.state
	}

	async getChatById(chatId: string): Promise<{ sendStateTyping: () => Promise<void> }> {
		return {
			sendStateTyping: async () => {
				this.typing.push(chatId)
			},
		}
	}

	async sendMessage(chatId: string, content: unknown, options?: unknown): Promise<unknown> {
		this.sent.push({ chatId, content, options: options ?? null })
		return { id: 'sent' }
	}

	async getMessageById(messageId: string): Promise<{ react: (emoji: string) => Promise<void> }> {
		return {
			react: async (emoji: string) => {
				this.reactions.push({ id: messageId, emoji })
			},
		}
	}

	async getContactLidAndPhone(userIds: string[]): Promise<Array<{ lid?: string; pn?: string }>> {
		return await this.lidLookup(userIds)
	}
}

type FakeStore = {
	load: () => Promise<void>
	entriesCount: () => number
	get: (lidRaw: string) => string | null
	getLidByPn: (pnRaw: string) => string | null
	set: (lidRaw: string, pnRaw: string) => Promise<boolean>
	setCalls: Array<{ lid: string; pn: string }>
	map: Map<string, string>
}

function makeStore(initial: Record<string, string> = {}): FakeStore {
	const map = new Map(Object.entries(initial))
	const setCalls: Array<{ lid: string; pn: string }> = []
	return {
		load: async () => undefined,
		entriesCount: () => map.size,
		get: (lidRaw: string) => map.get(lidRaw) ?? null,
		getLidByPn: (pnRaw: string) => {
			const digits = pnRaw.replace(/\D/g, '')
			if (!digits) return null
			const entries = Array.from(map.entries())
			for (let i = entries.length - 1; i >= 0; i -= 1) {
				const [lid, pn] = entries[i]!
				if (pn.replace(/\D/g, '') === digits) return lid
			}
			return null
		},
		set: async (lidRaw: string, pnRaw: string) => {
			setCalls.push({ lid: lidRaw, pn: pnRaw })
			map.set(lidRaw, pnRaw)
			return true
		},
		setCalls,
		map,
	}
}

function makeSut(params?: { nowMs?: number; store?: FakeStore }) {
	const fake = new FakeClient()
	const onIncoming = mock<BaseWhatsAppClientOptions['onIncoming']>(async () => undefined)
	const deps = {
		createClient: () => fake,
		messageMediaFromFilePath: (path: string) => ({ kind: 'media', path }),
		generateQr: mock((_: string) => undefined),
		nowMs: () => params?.nowMs ?? Date.now(),
	}
	const store = params?.store ?? makeStore()
	const client = new WWebJsWhatsAppClient(
		{
			authDir: '/tmp/kotaete-auth',
			onIncoming,
		},
		deps,
		store,
	)

	return { client, fake, onIncoming, deps, store }
}

describe('wwebjs createClientOptions', () => {
	test('includes expected LocalAuth and puppeteer defaults', () => {
		const previous = process.env.KOTAETE_PUPPETEER_EXECUTABLE_PATH
		delete process.env.KOTAETE_PUPPETEER_EXECUTABLE_PATH
		try {
			const options = __wwebjsTestInternals.createClientOptions('/tmp/auth')
			expect(options.authStrategy).toBeTruthy()
			expect(options.puppeteer?.headless).toBe(true)
			expect(options.puppeteer?.args).toEqual([
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage',
			])
		} finally {
			if (previous === undefined) {
				delete process.env.KOTAETE_PUPPETEER_EXECUTABLE_PATH
			} else {
				process.env.KOTAETE_PUPPETEER_EXECUTABLE_PATH = previous
			}
		}
	})

	test('injects executablePath when env is set', () => {
		const previous = process.env.KOTAETE_PUPPETEER_EXECUTABLE_PATH
		process.env.KOTAETE_PUPPETEER_EXECUTABLE_PATH = '/usr/bin/chromium'
		try {
			const options = __wwebjsTestInternals.createClientOptions('/tmp/auth')
			expect(options.puppeteer?.executablePath).toBe('/usr/bin/chromium')
		} finally {
			if (previous === undefined) {
				delete process.env.KOTAETE_PUPPETEER_EXECUTABLE_PATH
			} else {
				process.env.KOTAETE_PUPPETEER_EXECUTABLE_PATH = previous
			}
		}
	})
})

describe('wwebjs resolveBrowserExecutablePath', () => {
	test('prefers puppeteer executable env over everything else', () => {
		const resolved = __wwebjsTestInternals.resolveBrowserExecutablePath({
			env: {
				KOTAETE_PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium-custom',
				KOTAETE_PLAYWRIGHT_EXECUTABLE_PATH: '/pw/chrome',
			},
			homeDir: '/home/test',
			existsPath: () => true,
			listDirectoryNames: () => ['chromium-1208'],
		})

		expect(resolved).toBe('/usr/bin/chromium-custom')
	})

	test('uses playwright executable env when puppeteer env not set', () => {
		const resolved = __wwebjsTestInternals.resolveBrowserExecutablePath({
			env: {
				KOTAETE_PLAYWRIGHT_EXECUTABLE_PATH: '/pw/chrome',
			},
			homeDir: '/home/test',
			existsPath: () => false,
			listDirectoryNames: () => [],
		})

		expect(resolved).toBe('/pw/chrome')
	})

	test('auto-detects newest playwright chromium in cache', () => {
		const resolved = __wwebjsTestInternals.resolveBrowserExecutablePath({
			env: {},
			homeDir: '/home/test',
			existsPath: (path) => path === '/home/test/.cache/ms-playwright/chromium-1208/chrome-linux/chrome',
			listDirectoryNames: () => ['chromium-1194', 'chromium-1208', 'firefox-1200'],
		})

		expect(resolved).toBe('/home/test/.cache/ms-playwright/chromium-1208/chrome-linux/chrome')
	})

	test('returns null when no executable can be resolved', () => {
		const resolved = __wwebjsTestInternals.resolveBrowserExecutablePath({
			env: {},
			homeDir: '/home/test',
			existsPath: () => false,
			listDirectoryNames: () => [],
		})

		expect(resolved).toBeNull()
	})
})

describe('WWebJsWhatsAppClient behavior', () => {
	test('start initializes client', async () => {
		const { client, fake } = makeSut()
		await client.start()
		expect(fake.initialized).toBe(1)
	})

	test('maps incoming group message to onIncoming payload', async () => {
		const { client, fake, onIncoming } = makeSut()
		await client.start()

		fake.emit('ready')
		fake.emit('message', {
			from: '120363195640146772@g.us',
			author: '628123456789@s.whatsapp.net',
			body: '  jawaban benar  ',
			fromMe: false,
			id: { _serialized: 'MSG-123' },
		})

		await Bun.sleep(0)

		expect(onIncoming).toHaveBeenCalledTimes(1)
		expect(onIncoming.mock.calls[0]?.[0]).toEqual({
			groupId: '120363195640146772@g.us',
			senderRawJid: '628123456789@s.whatsapp.net',
			senderNumber: '628123456789',
			senderLid: null,
			text: 'jawaban benar',
			media: null,
			mentionedJids: [],
			key: {
				remoteJid: '120363195640146772@g.us',
				participant: '628123456789@s.whatsapp.net',
				id: 'MSG-123',
				fromMe: false,
			},
		})
	})

	test('resolves lid sender via cache without lookup', async () => {
		const store = makeStore({ '200729742577712@lid': '628777000111' })
		const { client, fake, onIncoming } = makeSut({ store })
		await client.start()
		fake.emit('ready')

		fake.emit('message', {
			from: '120@g.us',
			author: '200729742577712@lid',
			body: 'ans',
			fromMe: false,
			id: { _serialized: 'LID-CACHE-1' },
		})

		await Bun.sleep(0)

		expect(onIncoming).toHaveBeenCalledTimes(1)
		expect(onIncoming.mock.calls[0]?.[0]?.senderNumber).toBe('628777000111')
		expect(fake.lidLookup).toHaveBeenCalledTimes(0)
	})

	test('resolves lid sender via lookup and persists mapping', async () => {
		const store = makeStore()
		const { client, fake, onIncoming } = makeSut({ store })
		fake.lidLookup.mockImplementationOnce(async () => [{ lid: '200729742577712@lid', pn: '628888000222@c.us' }])
		await client.start()
		fake.emit('ready')

		fake.emit('message', {
			from: '120@g.us',
			author: '200729742577712@lid',
			body: 'ans',
			fromMe: false,
			id: { _serialized: 'LID-LOOKUP-1' },
		})

		await Bun.sleep(0)

		expect(onIncoming).toHaveBeenCalledTimes(1)
		expect(onIncoming.mock.calls[0]?.[0]?.senderNumber).toBe('628888000222')
		expect(fake.lidLookup).toHaveBeenCalledTimes(1)
		expect(store.setCalls).toEqual([{ lid: '200729742577712@lid', pn: '628888000222' }])
	})

	test('lookupPnByLid falls back to WhatsApp lookup when cache miss', async () => {
		const store = makeStore()
		const { client, fake } = makeSut({ store })
		fake.lidLookup.mockImplementationOnce(async () => [{ lid: '200729742577712@lid', pn: '628888000222@c.us' }])
		await client.start()
		fake.emit('ready')

		expect(await client.lookupPnByLid('200729742577712@lid')).toBe('628888000222')
		expect(fake.lidLookup).toHaveBeenCalledTimes(1)
	})

	test('lookupLidByPn falls back to WhatsApp lookup when cache miss', async () => {
		const store = makeStore()
		const { client, fake } = makeSut({ store })
		fake.lidLookup.mockImplementationOnce(async () => [{ lid: '999888777@lid', pn: '628123456789@s.whatsapp.net' }])
		await client.start()
		fake.emit('ready')

		expect(await client.lookupLidByPn('628123456789')).toBe('999888777@lid')
		expect(fake.lidLookup).toHaveBeenCalledTimes(1)
	})

	test('lookupLidByPn skips mismatched PN results and keeps probing candidates', async () => {
		const store = makeStore()
		const { client, fake } = makeSut({ store })
		fake.lidLookup.mockImplementationOnce(async () => [{ lid: '111@lid', pn: '628000000000@s.whatsapp.net' }])
		fake.lidLookup.mockImplementationOnce(async () => [{ lid: '222@lid', pn: '628123456789@c.us' }])
		await client.start()
		fake.emit('ready')

		expect(await client.lookupLidByPn('628123456789')).toBe('222@lid')
		expect(fake.lidLookup).toHaveBeenCalledTimes(2)
		expect(store.setCalls).toEqual([{ lid: '222@lid', pn: '628123456789' }])
	})

	test('lookupLidByPn returns null when provider returns no usable mapping', async () => {
		const store = makeStore()
		const { client, fake } = makeSut({ store })
		fake.lidLookup.mockImplementation(async () => [{ lid: '111@lid', pn: '628000000000@s.whatsapp.net' }])
		await client.start()
		fake.emit('ready')

		expect(await client.lookupLidByPn('628123456789')).toBeNull()
		expect(fake.lidLookup).toHaveBeenCalledTimes(3)
	})

	test('lookupLidByPn uses cache when available', async () => {
		const store = makeStore({ '999888777@lid': '628123456789' })
		const { client, fake } = makeSut({ store })
		await client.start()
		fake.emit('ready')

		expect(await client.lookupLidByPn('628123456789')).toBe('999888777@lid')
		expect(fake.lidLookup).toHaveBeenCalledTimes(0)
	})

	test('drops duplicate messages by message id', async () => {
		const { client, fake, onIncoming } = makeSut()
		await client.start()
		fake.emit('ready')

		const payload = {
			from: '120@g.us',
			author: '628123456789@s.whatsapp.net',
			body: 'dup',
			fromMe: false,
			id: { _serialized: 'DUP-1' },
		}

		fake.emit('message', payload)
		fake.emit('message', payload)

		await Bun.sleep(0)

		expect(onIncoming).toHaveBeenCalledTimes(1)
	})

	test('drops replayed old message after ready cutoff', async () => {
		const { client, fake, onIncoming } = makeSut({ nowMs: 2_000_000 })
		await client.start()
		fake.emit('ready')

		fake.emit('message', {
			from: '120@g.us',
			author: '628123456789@s.whatsapp.net',
			body: 'stale',
			fromMe: false,
			id: { _serialized: 'OLD-1' },
			timestamp: 1_900,
		})

		await Bun.sleep(0)
		expect(onIncoming).toHaveBeenCalledTimes(0)
	})

	test('ignores fromMe/private/empty messages', async () => {
		const { client, fake, onIncoming } = makeSut()
		await client.start()

		fake.emit('message', {
			from: '120363195640146772@g.us',
			author: '628123456789@s.whatsapp.net',
			body: 'hello',
			fromMe: true,
			id: { _serialized: 'M1' },
		})

		fake.emit('message', {
			from: '628123456789@c.us',
			author: '628123456789@c.us',
			body: 'hello',
			fromMe: false,
			id: { _serialized: 'M2' },
		})

		fake.emit('message', {
			from: '120363195640146772@g.us',
			author: '628123456789@s.whatsapp.net',
			body: '   ',
			fromMe: false,
			id: { _serialized: 'M3' },
		})

		await Promise.resolve()
		expect(onIncoming).toHaveBeenCalledTimes(0)
	})

	test('sendText forwards linkPreview option', async () => {
		const { client, fake } = makeSut()
		await client.start()

		await client.sendText('120@g.us', 'halo', { linkPreview: true })
		expect(fake.sent).toHaveLength(1)
		expect(fake.sent[0]).toEqual({
			chatId: '120@g.us',
			content: 'halo',
			options: { linkPreview: true },
		})
	})

	test('sendText forwards quoted message id when provided', async () => {
		const { client, fake } = makeSut()
		await client.start()

		await client.sendText('120@g.us', 'halo', {
			linkPreview: false,
			quotedKey: { id: 'MSG-Q1', remoteJid: '120@g.us' },
		})

		expect(fake.sent).toHaveLength(1)
		expect(fake.sent[0]).toEqual({
			chatId: '120@g.us',
			content: 'halo',
			options: { linkPreview: false, quotedMessageId: 'MSG-Q1' },
		})
	})

	test('sendTyping uses chat sendStateTyping', async () => {
		const { client, fake } = makeSut()
		await client.start()

		await client.sendTyping('120@g.us')
		expect(fake.typing).toEqual(['120@g.us'])
	})

	test('sendImageWithCaption uses media factory and caption', async () => {
		const { client, fake } = makeSut()
		await client.start()

		await client.sendImageWithCaption('120@g.us', '/tmp/img.jpg', 'caption')
		expect(fake.sent).toHaveLength(1)
		expect(fake.sent[0]).toEqual({
			chatId: '120@g.us',
			content: { kind: 'media', path: '/tmp/img.jpg' },
			options: { caption: 'caption' },
		})
	})

	test('react no-op when id missing; reacts when id present', async () => {
		const { client, fake } = makeSut()
		await client.start()

		await client.react('120@g.us', {}, '✅')
		expect(fake.reactions).toHaveLength(0)

		await client.react('120@g.us', { id: 'MSG-7' }, '🙊')
		expect(fake.reactions).toEqual([{ id: 'MSG-7', emoji: '🙊' }])
	})

	test('stop destroys client', async () => {
		const { client, fake } = makeSut()
		await client.start()
		await client.stop()
		expect(fake.destroyed).toBe(1)
	})

	test('isConnected returns false before ready event', async () => {
		const { client } = makeSut()
		await client.start()
		expect(await client.isConnected()).toBe(false)
	})

	test('isConnected returns true after ready event', async () => {
		const { client, fake } = makeSut()
		await client.start()
		fake.emit('ready')
		expect(await client.isConnected()).toBe(true)
	})

	test('isConnected returns false after disconnected event', async () => {
		const { client, fake } = makeSut()
		await client.start()
		fake.emit('ready')
		expect(await client.isConnected()).toBe(true)
		fake.emit('disconnected', 'test')
		expect(await client.isConnected()).toBe(false)
	})

	test('isConnected returns false after stop', async () => {
		const { client, fake } = makeSut()
		await client.start()
		fake.emit('ready')
		expect(await client.isConnected()).toBe(true)
		await client.stop()
		expect(await client.isConnected()).toBe(false)
	})
})
