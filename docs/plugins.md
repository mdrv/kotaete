# Plugin System

Kotaete's plugin system lets you extend the WhatsApp quiz bot with custom behavior — intercept messages, react to connection events, and send messages — without modifying the daemon core.

## Quick Start

### 1. Create a Plugin

```ts
// my-plugin.ts
import { definePlugin } from '@mdrv/kotaete'

export default definePlugin({
	name: 'greeter',
	version: '1.0.0',
	description: 'Greets new messages with a custom prefix',

	async setup(ctx, args) {
		const prefix = args.prefix ?? '!'

		return {
			async onIncomingMessage({ message }) {
				if (message.text.trim() === `${prefix}hello`) {
					await ctx.sendText(message.groupId, 'Hello! 👋', {
						quotedKey: message.key,
						linkPreview: false,
					})
				}
			},
		}
	},
})
```

### 2. Enable It

```bash
kotaete plugin enable ./my-plugin.ts --arg prefix=!
```

### 3. Manage

```bash
kotaete plugin list
kotaete plugin disable greeter
```

## CLI Commands

| Command                                             | Description                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `kotaete plugin enable <path> [--arg key=value]...` | Load and enable a plugin. Re-enabling the same plugin name reloads it. |
| `kotaete plugin disable <name>`                     | Disable a plugin by its declared name.                                 |
| `kotaete plugin list [--json]`                      | List all loaded plugins and their status.                              |

All commands accept `--socket <path>` to specify a custom daemon socket path.

Plugin arguments are passed as repeatable `--arg key=value` flags:

```bash
kotaete plugin enable ./ping.ts --arg prefix=/ --arg group=120363xxx@g.us
```

## Plugin Definition

Every plugin must export a default value created with `definePlugin()`:

```ts
import { definePlugin } from '@mdrv/kotaete'
import { z } from 'zod'

export default definePlugin({
	name: 'my-plugin', // Required — unique identifier
	version: '1.0.0', // Optional
	description: '...', // Optional

	// Optional: validate args with Zod
	argsSchema: z.object({
		prefix: z.string().default('!'),
		group: z.string().optional(),
	}),

	// Called once when the plugin is enabled
	async setup(ctx, args) {
		// Return hooks, or nothing
		return {
			async onIncomingMessage(event) {/* ... */},
			onWaConnected(event) {/* ... */},
			teardown(reason) {/* ... */},
		}
	},
})
```

### TypeScript Types

Import types for type-safe plugin development:

```ts
import type {
	KotaetePluginConnectedEvent,
	KotaetePluginContext,
	KotaetePluginHooks,
	KotaetePluginIncomingEvent,
	PluginRuntimeReason,
} from '@mdrv/kotaete'
```

## Plugin Context (ctx)

The `ctx` object passed to `setup()` provides a sandboxed API. Plugins **cannot** access the raw WhatsApp client, quiz engine, or daemon internals.

### Messaging

| Method                 | Signature                                                                     | Description                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `sendText`             | `(groupId, text, opts?) => Promise<OutgoingMessageKey \| null>`               | Send a text message. `opts` accepts `{ linkPreview?, quotedKey?, typing? }`. Typing defaults to `true`. |
| `sendImageWithCaption` | `(groupId, imagePath, caption, opts?) => Promise<OutgoingMessageKey \| null>` | Send an image with caption. `opts` accepts `{ typing? }`.                                               |
| `sendTyping`           | `(groupId) => Promise<void>`                                                  | Show typing indicator.                                                                                  |
| `react`                | `(groupId, key, emoji) => Promise<void>`                                      | React to a message with an emoji.                                                                       |

All messaging goes through the daemon's outbound queue, which serializes sends and adds typing indicators automatically.

### Identity

| Method          | Signature                          | Description                          |
| --------------- | ---------------------------------- | ------------------------------------ |
| `lookupPnByLid` | `(lid) => Promise<string \| null>` | Resolve a LID to a phone number JID. |
| `lookupLidByPn` | `(pn) => Promise<string \| null>`  | Resolve a phone number JID to a LID. |

### Status

| Method        | Signature                | Description                     |
| ------------- | ------------------------ | ------------------------------- |
| `isConnected` | `() => Promise<boolean>` | Check if WhatsApp is connected. |

### Logging

```ts
ctx.log.debug('verbose details')
ctx.log.info('normal message')
ctx.log.warn('something concerning')
ctx.log.error('something broke')
```

All log output is namespaced under `kotaete.plugin.<plugin-name>`.

### Read-only Properties

| Property     | Type     | Description                              |
| ------------ | -------- | ---------------------------------------- |
| `pluginName` | `string` | The plugin's declared name.              |
| `sourcePath` | `string` | Absolute path to the plugin source file. |

## Event Hooks

Return these from `setup()` to subscribe to events. All hooks are optional.

### `onIncomingMessage(event)`

Fired for every incoming group message received by the daemon. This fires **before** the quiz engine processes the message and is **non-blocking** — the quiz flow continues regardless of what the plugin does.

```ts
onIncomingMessage(event: KotaetePluginIncomingEvent): MaybePromise<void>
```

**Event shape:**

```ts
{
	message: IncomingGroupMessage // see below
	receivedAt: Date
}
```

**`IncomingGroupMessage`:**

```ts
{
	groupId: string // e.g. '120363xxx@g.us'
	senderRawJid: string // e.g. '6281234567@s.whatsapp.net'
	senderNumber: string | null // e.g. '6281234567'
	senderLid: string | null // e.g. 'abc123@lid'
	text: string // message text content
	key: MessageKeyLike // message key for replies/reactions
}
```

**`MessageKeyLike`:**

```ts
{
	remoteJid?: string | null
	participant?: string | null
	id?: string | null
	fromMe?: boolean | null
}
```

### `onWaConnected(event)`

Fired when the WhatsApp connection is established (or re-established). Also fires for each plugin when it's restored from the manifest on daemon startup (if WA is already connected).

```ts
onWaConnected(event: KotaetePluginConnectedEvent): MaybePromise<void>
```

**Event shape:**

```ts
{
	provider: 'wwebjs' | 'baileys'
	connectedAt: Date
}
```

### `teardown(reason)`

Called when the plugin is being disabled or the daemon is shutting down. Use this for cleanup.

```ts
teardown(reason: PluginRuntimeReason): MaybePromise<void>
```

**Reasons:**

| Reason              | When                                            |
| ------------------- | ----------------------------------------------- |
| `'manual-disable'`  | Disabled via `kotaete plugin disable`           |
| `'daemon-shutdown'` | Daemon is shutting down (SIGINT/SIGTERM)        |
| `'reload'`          | Plugin was re-enabled (same name, hot reload)   |
| `'error-threshold'` | Auto-disabled after 5 consecutive hook failures |

## Arguments

Plugins receive arguments from the CLI enable command as a `Record<string, string>`:

```bash
kotaete plugin enable ./my-plugin.ts --arg prefix=/ --arg group=120363xxx@g.us
# args = { prefix: '/', group: '120363xxx@g.us' }
```

### With Zod Validation

Provide an `argsSchema` to validate and transform arguments:

```ts
import { z } from 'zod'

export default definePlugin({
	name: 'scoped-ping',
	argsSchema: z.object({
		prefix: z.string().default('!'),
		group: z.string().optional(),
		maxReplies: z.coerce.number().default(1),
	}),
	async setup(ctx, args) {
		// args is typed as { prefix: string; group?: string; maxReplies: number }
		console.log(args.prefix) // string (default '!')
		console.log(args.maxReplies) // number (default 1)
		// ...
	},
})
```

Without `argsSchema`, `args` is typed as `Record<string, string>` (all string values).

## How It Works

### Architecture

```
CLI (kotaete plugin enable/disable/list)
 └── Unix Socket Relay ──────────────────────────────┐
                                                       ▼
DaemonRuntime                                        
 ├── PluginManager                                    
 │    ├── enable(sourcePath, args)                    
 │    │    ├── loadPlugin() → dynamic import()        
 │    │    ├── definition.setup(ctx, args) → hooks    
 │    │    └── PluginStore.add() → persist to disk    
 │    ├── disable(name)                               
 │    │    ├── hooks.teardown('manual-disable')       
 │    │    └── PluginStore.remove()                   
 │    ├── emitIncoming(message) → fire-and-forget    
 │    │    └── hooks.onIncomingMessage(event) per plugin
 │    ├── emitWaConnected() → fire-and-forget         
 │    │    └── hooks.onWaConnected(event) per plugin  
 │    └── shutdown() → teardown all ('daemon-shutdown')
 │                                                    
 ├── WhatsAppClient.onIncoming(message)               
 │    ├── pluginManager.emitIncoming(message)  ← non-blocking
 │    └── quiz engine dispatch                      
 │                                                    
 └── PluginStore (~/.kotaete/state/plugins.json)
```

### Loading

1. The CLI sends a `plugin-enable` relay request over the Unix socket.
2. The daemon's `PluginManager` calls `loadPlugin()` which does a dynamic `import()` of the source file.
3. The plugin's `setup()` is called with a `KotaetePluginContext` and the parsed arguments.
4. The returned hooks are stored in the active plugin registry.
5. The plugin is persisted to `~/.kotaete/state/plugins.json`.

### Persistence

Enabled plugins are saved to `~/.kotaete/state/plugins.json`:

```json
{
	"version": 1,
	"updatedAt": "2026-04-11T10:00:00.000Z",
	"plugins": [
		{
			"name": "ping",
			"sourcePath": "/absolute/path/to/ping.ts",
			"args": { "prefix": "!" },
			"enabledAt": "2026-04-11T10:00:00.000Z"
		}
	]
}
```

On daemon startup, `restoreFromManifest()` re-enables all persisted plugins. If a plugin fails to load (e.g., file deleted), it's removed from the manifest and a warning is logged.

### Event Model

**Fire-and-forget observer pattern** — plugin hooks are invoked asynchronously and do not block the daemon's main pipeline:

- `emitIncoming()` is called in the `onIncoming` callback, **before** quiz engine dispatch. It's `void`-returned (non-awaited), so plugin processing happens in parallel with quiz handling.
- `emitWaConnected()` fires once after WA connection is established.
- Each hook call is wrapped in a timeout (5 seconds) and try/catch.

### Error Isolation

Plugin errors cannot crash the daemon:

1. Every hook invocation is wrapped in `try/catch`.
2. Hooks have a **5-second timeout** — if a hook hangs, it's aborted.
3. **Consecutive failure tracking** — each hook failure increments a counter per plugin.
4. **Auto-disable** — after 5 consecutive failures, the plugin is automatically disabled with reason `'error-threshold'`.
5. The error counter resets on any successful hook call.
6. Teardown errors are logged but otherwise suppressed.

### Hot Reload

Enabling a plugin with the same name as an already-active plugin triggers a reload:

1. The existing plugin's `teardown('reload')` is called.
2. The new plugin is imported (with cache-busting for same-path reloads).
3. The new plugin's `setup()` is called.
4. The manifest entry is updated.

### Outbound Queue

All plugin messages go through the daemon's `enqueueOutbound()` serializer, which:

- Adds typing indicators before messages
- Enforces rate limiting between sends
- Serializes all outbound to prevent WhatsApp throttling

This means plugins share the same message queue as quiz messages — they won't flood the chat.

## File Layout

```
src/plugin/
├── types.ts          # Plugin type definitions
├── define-plugin.ts  # definePlugin() helper
├── manager.ts        # PluginManager — lifecycle, event emission, error tracking
├── store.ts          # PluginStore — JSON persistence
├── loader.ts         # Dynamic import + validation
└── index.ts          # Barrel exports

src/daemon/
├── protocol.ts       # Extended with plugin-enable/disable/list schemas
└── runtime.ts        # PluginManager wired into daemon lifecycle

src/cli/commands/
└── plugin.ts         # CLI commands (enable, disable, list)

examples/
└── ping-plugin.ts    # Example plugin
```

## Example: Echo Plugin

```ts
import { definePlugin } from '@mdrv/kotaete'

export default definePlugin({
	name: 'echo',
	description: 'Repeats messages that start with !echo',

	async setup(ctx, args) {
		const prefix = args.prefix ?? '!echo '

		return {
			async onIncomingMessage({ message }) {
				if (!message.text.startsWith(prefix)) return

				const text = message.text.slice(prefix.length)
				if (!text) return

				await ctx.sendText(message.groupId, text, {
					quotedKey: message.key,
					linkPreview: false,
				})
			},

			teardown(reason) {
				ctx.log.info(`echo plugin shutting down: ${reason}`)
			},
		}
	},
})
```

Enable:

```bash
kotaete plugin enable ./echo-plugin.ts --arg prefix=!echo
```

## Limitations (v1)

- **No middleware chain** — plugins observe events but cannot modify or block them.
- **API isolation only** — plugins share the same process; there's no sandboxing.
- **No dynamic flag schema** — CLI args are always `--arg key=value` strings. Use `argsSchema` (Zod) for validation and type coercion.
- **Single process** — all plugins run in the daemon process. CPU-heavy plugins may affect daemon responsiveness.
