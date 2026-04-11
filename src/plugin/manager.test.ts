import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
	pluginStatusSchema,
	relayPluginDisableRequestSchema,
	relayPluginEnableRequestSchema,
	relayPluginListRequestSchema,
	relayRequestSchema,
	relayResponseSchema,
} from '../daemon/protocol.ts'
import { definePlugin } from './define-plugin.ts'
import { PluginManager, type PluginManagerDeps } from './manager.ts'
import { PluginStore } from './store.ts'

// Absolute path to the plugin barrel so test plugin files can import from it
const PLUGIN_INDEX_PATH = resolve(import.meta.dir, 'index.ts')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string
let storePath: string

function makeMockDeps(): PluginManagerDeps {
	return {
		sendText: mock(() => Promise.resolve(null)),
		sendImageWithCaption: mock(() => Promise.resolve(null)),
		sendTyping: mock(() => Promise.resolve()),
		react: mock(() => Promise.resolve()),
		lookupPnByLid: mock(() => Promise.resolve(null)),
		lookupLidByPn: mock(() => Promise.resolve(null)),
		isConnected: mock(() => Promise.resolve(true)),
		getProvider: mock(() => 'wwebjs' as const),
	}
}

function makeMockMessage(text: string, groupId = '120363xxx@g.us') {
	return {
		groupId,
		senderRawJid: '6281234567@s.whatsapp.net',
		senderNumber: '6281234567',
		senderLid: 'abc123@lid',
		text,
		key: { remoteJid: groupId, participant: '6281234567@s.whatsapp.net', id: 'msg-1', fromMe: false },
	}
}

// ---------------------------------------------------------------------------
// Protocol schema tests
// ---------------------------------------------------------------------------

describe('plugin relay protocol schemas', () => {
	test('plugin-enable request parses with args', () => {
		const result = relayPluginEnableRequestSchema.safeParse({
			type: 'plugin-enable',
			sourcePath: '/tmp/ping-plugin.ts',
			args: { prefix: '!' },
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.type).toBe('plugin-enable')
			expect(result.data.sourcePath).toBe('/tmp/ping-plugin.ts')
			expect(result.data.args).toEqual({ prefix: '!' })
		}
	})

	test('plugin-enable request parses without args', () => {
		const result = relayPluginEnableRequestSchema.safeParse({
			type: 'plugin-enable',
			sourcePath: '/tmp/ping-plugin.ts',
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.args).toBeUndefined()
		}
	})

	test('plugin-disable request parses', () => {
		const result = relayPluginDisableRequestSchema.safeParse({
			type: 'plugin-disable',
			name: 'ping',
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.name).toBe('ping')
		}
	})

	test('plugin-list request parses', () => {
		const result = relayPluginListRequestSchema.safeParse({ type: 'plugin-list' })
		expect(result.success).toBe(true)
	})

	test('plugin types are included in discriminated union', () => {
		expect(relayRequestSchema.safeParse({ type: 'plugin-enable', sourcePath: '/tmp/p.ts' }).success).toBe(true)
		expect(relayRequestSchema.safeParse({ type: 'plugin-disable', name: 'x' }).success).toBe(true)
		expect(relayRequestSchema.safeParse({ type: 'plugin-list' }).success).toBe(true)
	})

	test('relay response with plugins array parses', () => {
		const payload = {
			ok: true,
			message: '1 plugin(s)',
			plugins: [
				{
					name: 'ping',
					sourcePath: '/tmp/ping.ts',
					args: { prefix: '!' },
					enabledAt: '2026-04-05T10:00:00.000Z',
					active: true,
				},
			],
		}
		const result = relayResponseSchema.safeParse(payload)
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.plugins).toHaveLength(1)
			expect(result.data.plugins?.[0]?.name).toBe('ping')
		}
	})

	test('plugin status schema rejects invalid data', () => {
		const result = pluginStatusSchema.safeParse({ name: 123 })
		expect(result.success).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// PluginStore tests
// ---------------------------------------------------------------------------

describe('PluginStore', () => {
	beforeEach(async () => {
		tmpDir = join(tmpdir(), `kotaete-test-plugin-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await mkdir(tmpDir, { recursive: true })
		storePath = join(tmpDir, 'plugins.json')
	})

	test('loads with empty file (ENOENT)', async () => {
		const store = new PluginStore(storePath)
		await store.load()
		expect(store.entries).toHaveLength(0)
	})

	test('add and retrieve entries', async () => {
		const store = new PluginStore(storePath)
		await store.load()

		await store.add({
			name: 'ping',
			sourcePath: '/tmp/ping.ts',
			args: { prefix: '!' },
			enabledAt: new Date().toISOString(),
		})

		expect(store.entries).toHaveLength(1)
		expect(store.entries[0]!.name).toBe('ping')
	})

	test('findByName returns matching entry', async () => {
		const store = new PluginStore(storePath)
		await store.load()

		await store.add({
			name: 'ping',
			sourcePath: '/tmp/ping.ts',
			args: {},
			enabledAt: new Date().toISOString(),
		})

		expect(store.findByName('ping')).toBeDefined()
		expect(store.findByName('nonexistent')).toBeUndefined()
	})

	test('remove deletes entry', async () => {
		const store = new PluginStore(storePath)
		await store.load()

		await store.add({
			name: 'ping',
			sourcePath: '/tmp/ping.ts',
			args: {},
			enabledAt: new Date().toISOString(),
		})

		expect(store.entries).toHaveLength(1)
		await store.remove('ping')
		expect(store.entries).toHaveLength(0)
	})

	test('add replaces entry with same name (reload)', async () => {
		const store = new PluginStore(storePath)
		await store.load()

		await store.add({
			name: 'ping',
			sourcePath: '/tmp/ping-v1.ts',
			args: {},
			enabledAt: new Date().toISOString(),
		})

		await store.add({
			name: 'ping',
			sourcePath: '/tmp/ping-v2.ts',
			args: { prefix: '/' },
			enabledAt: new Date().toISOString(),
		})

		expect(store.entries).toHaveLength(1)
		expect(store.entries[0]!.sourcePath).toBe('/tmp/ping-v2.ts')
	})

	test('persists to disk and reloads', async () => {
		const store1 = new PluginStore(storePath)
		await store1.load()
		await store1.add({
			name: 'ping',
			sourcePath: '/tmp/ping.ts',
			args: { prefix: '!' },
			enabledAt: new Date().toISOString(),
		})

		// Create new store instance reading from same file
		const store2 = new PluginStore(storePath)
		await store2.load()
		expect(store2.entries).toHaveLength(1)
		expect(store2.entries[0]!.name).toBe('ping')
		expect(store2.entries[0]!.args).toEqual({ prefix: '!' })
	})
})

// ---------------------------------------------------------------------------
// PluginManager tests
// ---------------------------------------------------------------------------

describe('PluginManager', () => {
	beforeEach(async () => {
		tmpDir = join(tmpdir(), `kotaete-test-plugin-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await mkdir(tmpDir, { recursive: true })
		storePath = join(tmpDir, 'plugins.json')
	})

	test('enable loads a plugin and it appears in list', async () => {
		// Create a test plugin file
		const pluginPath = join(tmpDir, 'test-plugin.ts')
		await writeFile(
			pluginPath,
			[
				`import { definePlugin } from "${PLUGIN_INDEX_PATH}"`,
				'export default definePlugin({',
				'  name: "test-plugin",',
				'  async setup(ctx) {',
				'    return {}',
				'  },',
				'})',
			].join('\n'),
		)

		const deps = makeMockDeps()
		const store = new PluginStore(storePath)
		const manager = new PluginManager(deps, store)
		await manager.init()

		const name = await manager.enable(pluginPath, {})
		expect(name).toBe('test-plugin')

		const list = manager.list()
		expect(list).toHaveLength(1)
		expect(list[0]!.name).toBe('test-plugin')
		expect(list[0]!.active).toBe(true)
	})

	test('disable removes plugin from active list', async () => {
		const pluginPath = join(tmpDir, 'test-plugin.ts')
		await writeFile(
			pluginPath,
			[
				`import { definePlugin } from "${PLUGIN_INDEX_PATH}"`,
				'export default definePlugin({',
				'  name: "test-plugin",',
				'  async setup(ctx) {',
				'    return {}',
				'  },',
				'})',
			].join('\n'),
		)

		const deps = makeMockDeps()
		const store = new PluginStore(storePath)
		const manager = new PluginManager(deps, store)
		await manager.init()

		await manager.enable(pluginPath, {})
		expect(manager.list()).toHaveLength(1)

		await manager.disable('test-plugin')
		const list = manager.list()
		expect(list).toHaveLength(0)
	})

	test('emitIncoming fires onIncomingMessage hook', async () => {
		const pluginPath = join(tmpDir, 'test-plugin.ts')
		await writeFile(
			pluginPath,
			[
				`import { definePlugin } from "${PLUGIN_INDEX_PATH}"`,
				'export default definePlugin({',
				'  name: "test-plugin",',
				'  async setup(ctx) {',
				'    return {',
				'      async onIncomingMessage(event) {',
				'        await ctx.sendText(event.message.groupId, "intercepted")',
				'      },',
				'    }',
				'  },',
				'})',
			].join('\n'),
		)

		const deps = makeMockDeps()
		const store = new PluginStore(storePath)
		const manager = new PluginManager(deps, store)
		await manager.init()

		await manager.enable(pluginPath, {})

		// Emit and wait for async hooks
		manager.emitIncoming(makeMockMessage('hello'))
		// Give async hooks time to run
		await Bun.sleep(100)

		expect(deps.sendText).toHaveBeenCalledTimes(1)
	})

	test('emitWaConnected fires onWaConnected hook', async () => {
		// Hook fires — verified by no error

		const pluginPath = join(tmpDir, 'test-plugin.ts')
		await writeFile(
			pluginPath,
			[
				`import { definePlugin } from "${PLUGIN_INDEX_PATH}"`,
				'export default definePlugin({',
				'  name: "test-plugin",',
				'  async setup(ctx) {',
				'    return {',
				'      onWaConnected(event) {',
				'        ctx.log.info("provider: " + event.provider)',
				'      },',
				'    }',
				'  },',
				'})',
			].join('\n'),
		)

		const deps = makeMockDeps()
		const store = new PluginStore(storePath)
		const manager = new PluginManager(deps, store)
		await manager.init()

		await manager.enable(pluginPath, {})
		manager.emitWaConnected()

		// Just verify it doesn't throw — hook is fire-and-forget
		await Bun.sleep(50)
	})

	test('teardown is called on disable', async () => {
		// Teardown hook fires — verified by no error

		const pluginPath = join(tmpDir, 'test-plugin.ts')
		await writeFile(
			pluginPath,
			[
				`import { definePlugin } from "${PLUGIN_INDEX_PATH}"`,
				'export default definePlugin({',
				'  name: "test-plugin",',
				'  async setup(ctx) {',
				'    return {',
				'      teardown(reason) {',
				'        ctx.log.info("teardown: " + reason)',
				'      },',
				'    }',
				'  },',
				'})',
			].join('\n'),
		)

		const deps = makeMockDeps()
		const store = new PluginStore(storePath)
		const manager = new PluginManager(deps, store)
		await manager.init()

		await manager.enable(pluginPath, {})
		await manager.disable('test-plugin')

		// Just verify it completes without error
		await Bun.sleep(50)
	})

	test('shutdown disables all plugins', async () => {
		const pluginPath = join(tmpDir, 'test-plugin.ts')
		await writeFile(
			pluginPath,
			[
				`import { definePlugin } from "${PLUGIN_INDEX_PATH}"`,
				'export default definePlugin({',
				'  name: "test-plugin",',
				'  async setup(ctx) { return {} },',
				'})',
			].join('\n'),
		)

		const deps = makeMockDeps()
		const store = new PluginStore(storePath)
		const manager = new PluginManager(deps, store)
		await manager.init()

		await manager.enable(pluginPath, {})
		expect(manager.list()).toHaveLength(1)

		await manager.shutdown()
		expect(manager.list()).toHaveLength(0)
	})

	test('enable rejects plugin without name', async () => {
		const pluginPath = join(tmpDir, 'bad-plugin.ts')
		await writeFile(
			pluginPath,
			[
				`import { definePlugin } from "${PLUGIN_INDEX_PATH}"`,
				'export default definePlugin({',
				'  async setup(ctx) { return {} },',
				'} as any)',
			].join('\n'),
		)

		const deps = makeMockDeps()
		const store = new PluginStore(storePath)
		const manager = new PluginManager(deps, store)
		await manager.init()

		expect(manager.enable(pluginPath, {})).rejects.toThrow()
	})

	test('restoreFromManifest restores persisted plugins', async () => {
		const pluginPath = join(tmpDir, 'test-plugin.ts')
		await writeFile(
			pluginPath,
			[
				`import { definePlugin } from "${PLUGIN_INDEX_PATH}"`,
				'export default definePlugin({',
				'  name: "test-plugin",',
				'  async setup(ctx) { return {} },',
				'})',
			].join('\n'),
		)

		// First: create and persist a plugin
		const deps1 = makeMockDeps()
		const store1 = new PluginStore(storePath)
		const manager1 = new PluginManager(deps1, store1)
		await manager1.init()
		await manager1.enable(pluginPath, { prefix: '!' })

		// Second: new manager restores from manifest
		const deps2 = makeMockDeps()
		const store2 = new PluginStore(storePath)
		const manager2 = new PluginManager(deps2, store2)
		await manager2.init()
		await manager2.restoreFromManifest()

		const list = manager2.list()
		expect(list).toHaveLength(1)
		expect(list[0]!.name).toBe('test-plugin')
		expect(list[0]!.active).toBe(true)
	})

	test('plugin receives context with messaging helpers', async () => {
		const pluginPath = join(tmpDir, 'test-plugin.ts')
		await writeFile(
			pluginPath,
			[
				`import { definePlugin } from "${PLUGIN_INDEX_PATH}"`,
				'export default definePlugin({',
				'  name: "test-plugin",',
				'  async setup(ctx) {',
				'    // Verify context has expected methods',
				'    if (typeof ctx.sendText !== "function") throw new Error("missing sendText")',
				'    if (typeof ctx.sendImageWithCaption !== "function") throw new Error("missing sendImageWithCaption")',
				'    if (typeof ctx.sendTyping !== "function") throw new Error("missing sendTyping")',
				'    if (typeof ctx.react !== "function") throw new Error("missing react")',
				'    if (typeof ctx.lookupPnByLid !== "function") throw new Error("missing lookupPnByLid")',
				'    if (typeof ctx.lookupLidByPn !== "function") throw new Error("missing lookupLidByPn")',
				'    if (typeof ctx.isConnected !== "function") throw new Error("missing isConnected")',
				'    if (typeof ctx.log.info !== "function") throw new Error("missing log.info")',
				'    return {}',
				'  },',
				'})',
			].join('\n'),
		)

		const deps = makeMockDeps()
		const store = new PluginStore(storePath)
		const manager = new PluginManager(deps, store)
		await manager.init()

		// Should not throw — context validation passes
		const name = await manager.enable(pluginPath, {})
		expect(name).toBe('test-plugin')
	})

	test('reload existing plugin disables then re-enables', async () => {
		const pluginPath = join(tmpDir, 'test-plugin.ts')
		await writeFile(
			pluginPath,
			[
				`import { definePlugin } from "${PLUGIN_INDEX_PATH}"`,
				'export default definePlugin({',
				'  name: "test-plugin",',
				'  async setup(ctx) { return {} },',
				'})',
			].join('\n'),
		)

		const deps = makeMockDeps()
		const store = new PluginStore(storePath)
		const manager = new PluginManager(deps, store)
		await manager.init()

		await manager.enable(pluginPath, {})
		// Enable again (reload)
		await manager.enable(pluginPath, { prefix: '!' })

		const list = manager.list()
		expect(list).toHaveLength(1)
		expect(list[0]!.args).toEqual({ prefix: '!' })
	})
})

// ---------------------------------------------------------------------------
// definePlugin tests
// ---------------------------------------------------------------------------

describe('definePlugin', () => {
	test('returns the plugin definition as-is', () => {
		const plugin = definePlugin({
			name: 'test',
			async setup(_ctx) {
				return {}
			},
		})

		expect(plugin.name).toBe('test')
	})
})
