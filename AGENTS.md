# AGENTS.md — NIPBANG Kotaete

## Project Overview

NIPBANG Kotaete (`@mdrv/kotaete`) is a WhatsApp-based Japanese quiz bot. It runs as a persistent daemon that connects to WhatsApp groups, sends quiz questions on schedule, accepts answers from group members, scores them in real-time, and tracks season-long leaderboards.

**Runtime:** Bun (`>=1.3`). Not Node.js.
**Language:** TypeScript (strict mode, ESNext, no semicolons via dprint ASI).
**Formatter:** dprint (config in `dprint.jsonc` — tabs, single quotes, no semicolons).
**CLI Framework:** Crust.js (`@crustjs/core` + `@crustjs/plugins`).
**Validation:** Zod (members loader).
**Path alias:** `@/*` → `./*` (tsconfig).

## Commands

```bash
bun run dev          # Run CLI
bun run daemon       # Start daemon (default provider: wwebjs)
bun run daemon:baileys  # Start daemon with Baileys provider (runs patch check first)
bun run test         # bun test
bun run check        # dprint format check + typecheck
bun run fmt          # dprint format
bun run typecheck    # bun tsc --noEmit
```

## Architecture

```
CLI (Crust.js)
 └── daemon.ts → DaemonRuntime (long-running process)
      ├── WhatsAppClient (facade)
      │    ├── WWebJsWhatsAppClient (default, Puppeteer-based)
      │    └── BaileysWhatsAppClient (WebSocket-based, experimental)
      ├── QuizEngine (state machine: idle → running → scoring)
      └── SeasonStore (persistent JSON-backed season scores)
```

### Source Layout

```
src/
├── cli/
│   ├── index.ts              # CLI entry point
│   ├── shared.ts             # Crust app instance, sendRelayRequest()
│   └── commands/
│       ├── daemon.ts         # `daemon` command (start the long-running bot)
│       ├── quiz.ts           # `quiz` command (debug/inspect)
│       ├── season.ts         # `season` commands (start, stop, scores, reset)
│       └── tool.ts           # `tool` commands (misc utilities)
├── daemon/
│   ├── runtime.ts            # DaemonRuntime — orchestrates WA + quiz + scheduling
│   └── protocol.ts           # Unix socket protocol schemas (Zod-based)
├── quiz/
│   ├── engine.ts             # QuizEngine — state machine, answer handling, timers
│   ├── loader.ts             # Quiz bundle loader from config dirs + markdown files
│   ├── messages.ts           # All WhatsApp message formatters
│   ├── answer-checker.ts     # Answer normalization + matching
│   ├── scoring.ts            # Point calculation (correct/wrong, caps)
│   ├── season-store.ts       # Season score persistence (~/.kotaete/state/)
│   └── season-scoreboard.ts  # Season-end scoreboard formatting
├── whatsapp/
│   ├── client.ts             # WhatsAppClient facade (provider selection)
│   ├── types.ts              # IWhatsAppClient interface, WhatsAppProvider
│   ├── wwebjs-client.ts      # whatsapp-web.js provider implementation
│   ├── baileys-client.ts     # Baileys provider implementation
│   └── lid-pn-store.ts       # Persistent LID↔PN mapping store
├── members/
│   └── loader.ts             # Member list loader (JSON/TS, Zod-validated)
├── utils/
│   ├── normalize.ts          # JID/phone/LID normalization utilities
│   └── path.ts               # Path resolution helpers
├── constants.ts              # App constants, quiz tunables, reaction emojis
├── logger.ts                 # Structured logging (logtape)
└── types.ts                  # Core type definitions
```

## Key Concepts

### Quiz Flow

1. **Config-based (primary):** Quiz questions are defined in `kotaete.ts` files inside quiz directories (e.g., `~/.kotaete/w20260405/kotaete.ts`). The config specifies schedule, rounds, questions with multi-type answers (kana/romaji/kanji), image templates, members, and message overrides.
2. **Markdown-based (legacy):** Questions can also be `.md` files in a quiz directory with `---`-separated sections (text, answers, explanation).
3. **Daemon:** The daemon loads a quiz bundle, waits for scheduled intro time, sends questions per-round schedule, accepts/validates answers, tracks scores, and sends results.

### Answer Types

Each question supports three answer types (all optional):

- **kana** (`string | { text, extraPts? }`) — Japanese reading in kana/katakana
- **romaji** (`string | { text, extraPts? }`) — Romanized reading + kana type (e.g., `"ringo hiragana"`)
- **kanji** (`string | { text, extraPts? }`) — Kanji representation

`extraPts` awards bonus points to any correct answer when the question has it configured (not limited to kanji). The 🌸 emoji in the options block indicates bonus availability per-type.

### Member Identity

WhatsApp uses both LID (Linked ID, e.g., `abc@lid`) and PN (phone number, e.g., `628xxx@s.whatsapp.net`). Members are identified by LID in the quiz engine. The `LidPnStore` provides persistent LID↔PN mapping. The `IWhatsAppClient.lookupPnByLid()` / `lookupLidByPn()` methods handle resolution.

### Scoring

- **Normal stage:** Max 10 pts per correct answer (decreasing by 1 per wrong attempt). 1 pt per wrong answer.
- **God stage (q#99):** Fixed 25 pts, no cooldown, one attempt per member, 30-min timeout.
- **extraPts:** Bonus on top of correct answer points (configurable per question).
- **Tie-breaking:** Higher score wins; ties broken by who reached that score first (timestamp).

### Seasons

Seasons track cumulative scores across multiple quiz sessions. Stored in `~/.kotaete/state/season-points.json`. CLI: `season start`, `season stop`, `season scores`, `season reset`.

### Message Templates

All user-facing WhatsApp messages are defined in `QuizMessageTemplates` (default values in `messages.ts`). Quiz configs can override any template via `messages: { ... }`. Templates use `{placeholder}` syntax.

## Config Format (kotaete.ts)

```typescript
import { defineConfig } from '@mdrv/kotaete'

export default defineConfig({
	groupId: '120363xxx@g.us',
	intro: new Date('2026-04-05T11:15+07:00'),
	rounds: [
		{
			emoji: '🏞️',
			start: new Date('2026-04-05T11:30+07:00'),
			questionRange: [1, 3],
			godStage: 98,
		},
	],
	questions: [
		{
			no: 1,
			hint: '＿ス',
			answers: {
				kana: { text: 'リス', extraPts: 2 },
				romaji: 'risu katakana',
				kanji: { text: '栗鼠', extraPts: 2 },
			},
			explanation: '*リス*(_risu_) = tupai\n...',
			image: {
				credit: 'Frieren (2023)',
				jp: 'これは何ですか？',
				romaji: 'kore ha nan desu ka?',
			},
		},
	],
	messages: { intro: 'Custom intro text', outro: 'Custom outro text' },
	season: { id: 'nipbang-01', caption: 'Season 1' },
})
```

## Crust CLI Framework Notes

- Boolean flags must be defined positively (e.g., `scoreboard`). Users negate via `--no-` prefix (e.g., `--no-scoreboard`). Never define flags starting with `no-`.
- Use `sendRelayRequest()` from `shared.ts` for CLI→daemon communication over Unix socket.

## WhatsApp Providers

### WWebJS (default)

- Uses `whatsapp-web.js` with Puppeteer
- Auth: `~/.kotaete/auth/wwebjs/` (LocalAuth strategy)

### Baileys (experimental)

- Uses `@whiskeysockets/baileys` (pinned to `github:WhiskeySockets/Baileys#d077902`)
- Auth: `~/.kotaete/auth/baileys/` (multi-file auth state)
- **Postinstall patches** (`scripts/patch-baileys-linking.ts`): Modifies Baileys source to fix "couldn't link device" issue:
  - `validate-connection.js`: `passive: true → false`, `lidDbMigrated: false → true`
  - `socket.js`: `await noise.finishInit() → noise.finishInit()`
- **makeInMemoryStore + getMessage callback:** Added to resolve "waiting for this message" / "Closing session" Signal protocol race conditions.
- Dynamic import via `Function()` to avoid Bun bundling issues.
- `daemon:baileys` script runs `baileys:patch:check` before starting.

## Testing

- Framework: `bun test`
- Tests colocated with source: `*.test.ts` files
- 156 tests across 11 files covering engine, loader, messages, scoring, season-store, daemon protocol, member loader, and WhatsApp client utilities.

## State Files

```
~/.kotaete/
├── auth/
│   ├── baileys/         # Baileys auth state
│   └── wwebjs/          # WWebJS auth state (Puppeteer session)
├── state/
│   ├── season-points.json   # Season scores
│   ├── lid-pn-map.json      # LID↔PN mapping cache
│   └── daemon-runtime.json  # Daemon runtime state
├── daemon.sock           # Unix socket for CLI→daemon relay
└── daemon.lock           # Daemon lock file
```

## Important Conventions

- **Formatting:** No semicolons (ASI). Tabs for indentation. Single quotes. Run `bun run fmt` before committing.
- **TypeScript strict:** `strict`, `noUnusedLocals`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are all enabled.
- **Imports:** Use `.ts` extensions in imports (Bun resolves them).
- **Logging:** Use `getLogger(['kotaete', ...category])` from `logger.ts`. Levels: `debug`, `info`, `warning`, `error`.
- **Time zones:** All schedule times are in WIB (Asia/Jakarta, UTC+7). The engine formats times in WIB.
- **Quiz directories:** Named with date prefix pattern `wYYYYMMDD` (e.g., `w20260405`). Contain `kotaete.ts` config, question images, and optionally `intro.md`/`outro.md` (config `messages.intro`/`messages.outro` takes priority).
