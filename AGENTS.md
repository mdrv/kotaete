# AGENTS.md — NIPBANG Kotaete

## Project Overview

NIPBANG Kotaete (`@mdrv/kotaete`) is a WhatsApp-based Japanese quiz bot. It runs as a persistent daemon that connects to WhatsApp groups, sends quiz questions on schedule, accepts answers from group members, scores them in real-time, and tracks season-long leaderboards. Includes a SvelteKit web dashboard for live spectator view.

**Runtime:** Bun (`>=1.3`). Not Node.js.
**Language:** TypeScript (strict mode, ESNext, no semicolons via dprint ASI).
**Formatter:** dprint (config in `dprint.jsonc` — tabs, single quotes, no semicolons).
**CLI Framework:** Crust.js (`@crustjs/core` + `@crustjs/plugins`).
**Validation:** Zod v4 (`^4.3.6`).
**Database:** SurrealDB (`^2.0.3`) for season scores, event logging, and live dashboard.
**Path alias:** `@/*` → `./*` (tsconfig).

## Commands

```bash
bun run dev              # Run CLI
bun run daemon           # Start daemon (default provider: wwebjs)
bun run daemon:baileys   # Start daemon with Baileys provider
bun run test             # bun test
bun run check            # dprint format check + typecheck
bun run fmt              # dprint format
bun run typecheck        # bun tsc --noEmit
```

## Architecture

```
CLI (Crust.js)
 └── daemon.ts → DaemonRuntime (long-running process)
      ├── WhatsAppClient (facade)
      │    ├── WWebJsWhatsAppClient (default, Puppeteer-based)
      │    └── BaileysWhatsAppClient (WebSocket-based, experimental)
      ├── QuizEngine (state machine: idle → running → scoring)
      ├── SeasonStore (SurrealDB-backed season scores)
      ├── QuizEventLogger (SurrealDB-backed live event tracking)
      ├── PluginManager (hot-loadable plugin system)
      └── [Unix Socket] ← CLI relay (run, status, stop, plugins)
Web (SvelteKit)
 └── Dashboard ← SurrealDB live subscriptions ← QuizEventLogger
```

### Source Layout

```
src/
├── index.ts                   # Public API exports (definePlugin, defineConfig, types)
├── types.ts                   # Core type definitions
├── constants.ts               # App constants, quiz tunables, reaction emojis
├── logger.ts                  # Structured logging (logtape)
├── copilot-auth.ts            # GitHub Copilot OAuth device flow + session token mgmt
├── cli/
│   ├── index.ts               # CLI entry point — registers all commands
│   ├── shared.ts              # Crust app instance, sendRelayRequest()
│   └── commands/
│       ├── daemon.ts          # `daemon` command (start the long-running bot)
│       ├── auth.ts            # `auth copilot` command
│       ├── quiz.ts            # `quiz status|stop|run` commands
│       ├── season.ts          # `season stop|show|add|set|reset|clear` commands
│       ├── run.ts             # Shared run handler for quiz run
│       ├── tool.ts            # `tool to-pn|to-lid` commands
│       ├── plugin.ts          # `plugin enable|disable|list` commands
│       └── x.ts               # `x ask close|open|tool` commands
├── daemon/
│   ├── runtime.ts             # DaemonRuntime — orchestrates WA + quiz + scheduling
│   ├── protocol.ts            # Unix socket request/response schemas (Zod)
│   ├── protocol.test.ts
│   └── queue.test.ts
├── quiz/
│   ├── engine.ts              # QuizEngine — state machine, answer handling, timers
│   ├── checkpoint.ts           # QuizStateCheckpoint type + Zod schema (crash recovery)
│   ├── loader.ts              # Quiz bundle loader + defineConfig()
│   ├── messages.ts            # All WhatsApp message formatters
│   ├── answer-checker.ts      # Answer normalization + matching
│   ├── scoring.ts             # Point calculation (correct/wrong, caps)
│   ├── season-store.ts        # Season score persistence (SurrealDB-backed)
│   ├── season-scoreboard.ts   # Season-end scoreboard image generation
│   ├── event-logger.ts        # SurrealDB event logging for live dashboard
│   ├── engine.test.ts
│   ├── messages.test.ts
│   ├── season-scoreboard.test.ts
│   ├── loader.test.ts
│   └── scoring.test.ts
├── whatsapp/
│   ├── client.ts              # WhatsAppClient facade (provider selection)
│   ├── types.ts               # IWhatsAppClient interface, WhatsAppProvider
│   ├── wwebjs-client.ts       # whatsapp-web.js provider implementation
│   ├── baileys-client.ts      # Baileys provider implementation
│   ├── lid-pn-store.ts        # Persistent LID↔PN mapping store
│   ├── wwebjs-client.test.ts
│   ├── baileys-client.test.ts
│   ├── types.test.ts
│   └── lid-pn-store.test.ts
├── members/
│   └── loader.ts              # Member list loader (JSON/TS, Zod-validated)
├── plugin/
│   ├── index.ts               # Re-exports
│   ├── types.ts               # Plugin system types
│   ├── define-plugin.ts       # definePlugin() helper
│   ├── loader.ts              # Dynamic plugin module loader
│   ├── manager.ts             # PluginManager — lifecycle, hooks, error handling
│   ├── store.ts               # Plugin manifest persistence (SurrealDB plugin_manifest)
│   └── manager.test.ts
└── utils/
    ├── normalize.ts           # JID/phone/LID normalization utilities
    ├── path.ts                # Path resolution helpers
    └── searxng.ts             # SearXNG search utility
```

### Web Frontend (`web/`)

SvelteKit 2 + Svelte 5 + Vite 8, adapter-node.

**Important:** Server-side features (SurrealDB connection, web_status heartbeat, WebSocket) must work in **both** `vite dev` and production (`bun run server.ts`). Code that only runs in `server.ts` will be skipped during dev. Place shared server-side logic in `src/lib/server/` modules that load on first API/hook request, not in `server.ts` directly.

```
web/
├── server.ts                  # Production HTTP server + WebSocket (KotaeteWsServer)
├── src/
│   ├── routes/
│   │   ├── +page.svelte          # Main dashboard
│   │   └── api/
│   │       ├── active/           # Active quiz sessions
│   │       ├── events/[sessionId]/  # Event stream
│   │       ├── image/[sessionId]/[questionNo]/  # Question images
│   │       ├── season/[id]/      # Season scores
│   │       └── seasons/          # Season list
│   └── lib/
│       ├── live-connection.ts    # WebSocket client (reconnect, live updates)
│       ├── components/
│       │   └── Dashboard.svelte  # Main UI component
│       └── server/
│           ├── surreal.ts        # SurrealDB connection singleton
│           └── ws-handler.ts     # SurrealDB live subscriptions → WebSocket broadcast
```

## Key Concepts

### Quiz Flow

1. **Config-based (primary):** Quiz questions are defined in `kotaete.ts` files inside quiz directories (e.g., `~/.kotaete/w20260405/kotaete.ts`). The config specifies schedule, rounds, questions with multi-type answers (kana/romaji/kanji), image templates, members, and message overrides.
2. **Markdown-based (legacy):** Questions can also be `.md` files in a quiz directory with `---`-separated sections (text, answers, explanation).
3. **Daemon:** The daemon loads a quiz bundle, waits for scheduled intro time, sends questions per-round schedule, accepts/validates answers, tracks scores, and sends results.
4. **State recovery:** On daemon restart, quiz state is recovered from SurrealDB checkpoints. The engine resumes from the exact question it was on, preserving scores and cooldowns.
5. **Crash safety:** The quiz loop is wrapped in try/catch. If any handler throws, `finishQuiz()` is called to ensure scoreboard and season scores are still generated. Timer callbacks also have error handling.

### Answer Types

Each question supports three answer types (all optional):

- **kana** (`string | { text, extraPts? }`) — Japanese reading in kana/katakana
- **romaji** (`string | { text, extraPts? }`) — Romanized reading + kana type (e.g., `"ringo hiragana"`)
- **kanji** (`string | { text, extraPts? }`) — Kanji representation

`extraPts` awards bonus points to any correct answer when the question has it configured (not limited to kanji). The 🌸 emoji in the options block indicates bonus availability per-type.

### Member Identity

WhatsApp uses both LID (Linked ID, e.g., `abc@lid`) and PN (phone number, e.g., `628xxx@s.whatsapp.net`). Members are identified by LID in the quiz engine. The `LidPnStore` provides persistent LID↔PN mapping. The `IWhatsAppClient.lookupPnByLid()` / `lookupLidByPn()` methods handle resolution.

### Scoring

- **Normal stage:** Max 10 pts per correct answer (decreasing by 1 per wrong attempt). 1 pt per wrong answer. Max 2 wrong attempts per member per question.
- **God stage (q#99):** Fixed 15 pts, no cooldown, one attempt per member, 30-min timeout.
- **extraPts:** Bonus on top of correct answer points (configurable per question).
- **Tie-breaking:** Higher score wins; ties broken by who reached that score first (timestamp).

### Seasons

Seasons track cumulative scores across multiple quiz sessions. Stored in SurrealDB (`season` + `season_score` tables). CLI: `season stop`, `season show`, `season add`, `season set`, `season reset`, `season clear`.

### Quiz State Recovery

On daemon crash or restart, the quiz engine can resume mid-quiz using SurrealDB checkpoints:

- **Checkpoint rows**: `daemon_checkpoint` table keyed by `job_id` — persisted after every question sent and every correct answer
- **QuizStateCheckpoint**: Captures `index`, `roundIndex`, `roundQuestionIndex`, `acceptingAnswers`, `deadlineAtMs`, all score maps, cooldowns, wrong streaks, and warning state
- **Recovery phases**:
  - **Phase A** (index=-1): Quiz never started → run from scratch with schedule times
  - **Phase B** (acceptingAnswers=true): Mid-question → re-send question with remaining time
  - **Phase C** (acceptingAnswers=false): Between questions → advance to next
  - **Phase D** (past last question): Call finishQuiz immediately
- **Engine methods**: `resume()` for recovery, `exportCheckpoint()` for serialization, `saveCheckpoint` callback in constructor opts
- **DaemonRuntime**: `persistCheckpoint()`, `loadCheckpoint()`, `deleteCheckpoint()` — persisted in SurrealDB. Checkpoints deleted on clean job finish.

### Message Templates

All user-facing WhatsApp messages are defined in `QuizMessageTemplates` (default values in `messages.ts`). Quiz configs can override any template via `messages: { ... }`. Templates use `{placeholder}` syntax.

### Plugin System

Hot-loadable plugins with hooks, tools, and error thresholds. Manifest persisted in SurrealDB (`plugin_manifest`). CLI: `plugin enable`, `plugin disable`, `plugin list`.

## SurrealDB Schema

**Connection:** `http://localhost:596/rpc`, namespace `medrivia`, database `nipbang_kotaete`.

### Tables

| Table               | Purpose                    | Key Fields                                                                                    |
| ------------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| `quiz_session`      | Mutable quiz session state | `group_id`, `status`, `current_question`, `current_round`, `accepting_answers`, `deadline_at` |
| `quiz_event`        | Append-only event log      | `session_id`, `event_type`, `question_no`, `member_mid`, `data`                               |
| `live_score`        | Per-member live scoreboard | `session_id`, `member_mid`, `points`, `reached_at`                                            |
| `live_member_state` | Per-member transient state | `session_id`, `member_mid`, `cooldown_until`, `wrong_remaining`                               |
| `season`            | Season metadata            | `season_id` (unique), `group_id`, `caption`, `status`                                         |
| `season_score`      | Season score records       | `season_id` + `mid` (unique), `points`, `reached_at`                                          |
| `daemon_job`        | Daemon runtime job state   | `job_id` (unique), schedule/runtime metadata                                                  |
| `daemon_checkpoint` | Quiz crash-recovery state  | `job_id` (unique), `checkpoint`                                                               |
| `plugin_manifest`   | Enabled plugin manifest    | `name` (unique), `source_path`, `args`, `enabled_at`                                          |

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

	- Uses `@whiskeysockets/baileys` (latest master, peerDependency)
	- Auth: `~/.kotaete/auth/baileys/` (multi-file auth state)
	- **makeInMemoryStore + getMessage callback:** Added to resolve "waiting for this message" / "Closing session" Signal protocol race conditions.
	- Dynamic import via `Function()` to avoid Bun bundling issues.

## Testing

- Framework: `bun test`
- Tests colocated with source: `*.test.ts` files
- 209 tests across 13 files covering engine, loader, messages, scoring, season-scoreboard, daemon protocol, member loader, plugin manager, and WhatsApp client utilities.

## State Files

```
~/.kotaete/
├── auth/
│   ├── baileys/              # Baileys auth state
│   └── wwebjs/               # WWebJS auth state (Puppeteer session)
├── state/
│   └── lid-pn-map.json       # LID↔PN mapping cache
├── avatars/                  # Member avatar JPGs (<mid>.jpg, default.jpg)
├── scoreboard-template.svg   # Scoreboard SVG template
├── daemon.sock               # Unix socket for CLI→daemon relay
└── daemon.lock               # Daemon lock file
```

## Important Conventions

- **Formatting:** No semicolons (ASI). Tabs for indentation. Single quotes. Run `bun run fmt` before committing.
- **TypeScript strict:** `strict`, `noUnusedLocals`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are all enabled.
- **Imports:** Use `.ts` extensions in imports (Bun resolves them).
- **Logging:** Use `getLogger(['kotaete', ...category])` from `logger.ts`. Levels: `debug`, `info`, `warning`, `error`.
- **Time zones:** All schedule times are in WIB (Asia/Jakarta, UTC+7). The engine formats times in WIB.
- **Quiz directories:** Named with date prefix pattern `wYYYYMMDD` (e.g., `w20260405`). Contain `kotaete.ts` config, question images, and optionally `intro.md`/`outro.md` (config `messages.intro`/`messages.outro` takes priority).
- **SurrealDB writes:** Use chained promises (`chain()`) for serial writes. Reads use direct `query()`.
- **Daemon state persistence:** Uses atomic write (tmp file + rename) pattern via `persistState()`.
- **Checkpoint persistence:** Uses atomic write (tmp file + rename) via `persistCheckpoint()`. Written after every `moveToNextQuestion()` call and every `handleCorrect()` score update. Deleted on `finishJob()`.
- **Engine error handling:** `run()` and `resume()` wrap the quiz loop in try/catch, calling `finishQuiz()` on failure. All `setTimeout` callbacks (timeout, warning, startRound) have `.catch()` handlers.
