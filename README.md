# NIPBANG Kotaete

WhatsApp-based Japanese quiz bot that runs as a persistent daemon, sends quiz questions on schedule, accepts answers from group members, scores them in real-time, and tracks season-long leaderboards.

## Features

- **Persistent Daemon**: Runs continuously in the background
- **Scheduled Quizzes**: Configurable intro time and multiple rounds with custom start times
- **Real-time Scoring**: Points awarded for correct answers, penalties for wrong answers
- **Answer Flexibility**: Supports kana, romaji, and kanji answers with optional bonus points
- **God Stage**: Special high-value question (default: question 98) with increased points and no cooldown
- **Season Tracking**: Cumulative scores across multiple quiz sessions with leaderboards
- **Multi-platform WhatsApp**: Supports both whatsapp-web.js (default) and Baileys (experimental) providers
- **Rich Media**: SVG-based question images with customizable templates
- **Extensible**: Override message templates, scoring rules, and more via configuration
- **Web Spectator (upcoming)**: Live web dashboard for real-time quiz viewing via SurrealDB event stream

## Quick Start

0. **Set up SurrealDB** (required for season tracking and event logging):
   ```bash
   # Using Docker
   docker run -d --name surrealdb -p 596:8000 surrealdb/surrealdb:latest start --user ua --pass japan8 memory

   # Or install directly
   surreal start --bind 0.0.0.0:596 --user ua --pass japan8 memory
   ```

1. **Install dependencies**:
   ```bash
   bun install
   ```

2. **Create a quiz directory**:
   ```bash
   mkdir -p ~/.kotaete/w20260405
   cp kotaete.example.ts ~/.kotaete/w20260405/kotaete.ts
   ```

3. **Edit the configuration**:
   - Update `groupId` to your WhatsApp group JID
   - Adjust dates/times for your quiz schedule
   - Customize questions, answers, and images as needed

4. **Start the daemon**:
   ```bash
   # Default provider (whatsapp-web.js)
   bun run daemon

   # Experimental Baileys provider
   bun run daemon:baileys
   ```

## Configuration

See [`kotaete.example.ts`](./kotaete.example.ts) for a complete example showing all available options.

The configuration file (`kotaete.ts`) supports:

- **Group Settings**: WhatsApp group ID and season tracking
- **Schedule**: Intro time and multiple rounds with custom emojis
- **Questions**: Kana/romaji/kanji answers with hints, explanations, and images
- **Messages**: Customizable WhatsApp message templates (including god stage announcement)
- **Members**: Optional explicit member list (defaults to all group participants)
- **Image Templates**: Custom SVG templates for question generation

## Commands

```bash
bun run dev          # Run CLI interactively
bun run daemon       # Start daemon (default provider: wwebjs)
bun run daemon:baileys  # Start daemon with Baileys provider
bun run test         # Run test suite
bun run check        # Format check + typecheck
bun run fmt          # Format code with dprint
bun run typecheck    # TypeScript type check
```

## Daemon Commands (via CLI)

Once the daemon is running, you can control it with:

```bash
bun run kotaete quiz        # Inspect current quiz state
bun run kotaete season start # Start season tracking
bun run kotaete season stop  # Stop season tracking
bun run kotaete season scores # Show season leaderboard
bun run kotaete season reset # Reset season scores
```

## Project Structure

```
src/
├── cli/                 # CLI entry point and commands
├── daemon/              # Daemon runtime and Unix socket protocol
├── quiz/                # Quiz engine, scoring, and message formatting
├── event-logger.ts       # Quiz event logging to SurrealDB
├── whatsapp/            # WhatsApp client abstractions (wwebjs, baileys)
├── members/             # Member list loading and validation
├── utils/               # Helper functions (normalization, paths)
├── constants.ts         # App constants and quiz tunables
├── logger.ts            # Structured logging
└── types.ts             # Shared TypeScript types
web/                    # Web spectator frontend (SvelteKit, upcoming)
```

## Quiz Tunables

Adjust scoring and timing behavior via `QUIZ_TUNABLES` in `src/constants.ts`:

- `points.normalCap`: Max points for normal correct answers (default: 10)
- `points.special`: Fixed points for god stage answers (default: 15)
- `points.kanjiBonus`: Bonus points for kanji-containing answers (default: 2)
- `timeout.normalMs`: Normal question timeout in ms (default: 60 min)
- `timeout.specialMs`: God stage question timeout in ms (default: 30 min)
- `cooldown.ms`: Cooldown duration after correct answer (default: 25 min)
- `wrongAttempts.maxCount`: Wrong answers allowed per player (default: 2)

## Answer Types

Each question supports three answer types (all optional):

- **kana** (`string | { text, extraPts? }`) — Japanese reading in kana/katakana
- **romaji** (`string | { text, extraPts? }`) — Romanized reading + kana type
- **kanji** (`string | { text, extraPts? }`) — Kanji representation

The `extraPts` field awards bonus points on top of the correct answer score when that answer type is correct.

## Scoring

- **Normal Stage**: Max 10 pts per correct answer (decreasing by 1 per wrong attempt). 1 pt per wrong answer.
- **God Stage (q#98)**: Fixed points (default: 15), no cooldown, one attempt per member, 30-min timeout.
- **extraPts**: Bonus points added to correct answer score (configurable per question).
- **Tie-breaking**: Higher score wins; ties broken by who reached that score first.

## Message Templates

All user-facing WhatsApp messages are defined in `QuizMessageTemplates`. Quiz configs can override any template via the `messages` field. Templates use `{placeholder}` syntax.

Special placeholders in `godStageAnnouncement`:

- `{points}` → Points for correct god stage answer (from `QUIZ_TUNABLES.points.special`)
- `{timeoutMinutes}` → God stage timeout in minutes (from `QUIZ_TUNABLES.timeout.specialMs`)
- `{delayMinutes>` → Delay before god stage question appears (from `QUIZ_TUNABLES.timeout.godAnnounceDelayMs`)

## Testing

```bash
bun test              # Run all tests
bun test src/quiz/    # Run quiz-specific tests
```

## State Storage

Quiz state is persisted in SurrealDB:

| Path/Table                | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `season` table            | Season metadata (id, group, status)                 |
| `season_score` table      | Cumulative season scores per member                 |
| `quiz_session` table      | Active quiz session state                           |
| `quiz_event` table        | Append-only quiz event log                          |
| `live_score` table        | Per-member score projection for live viewing        |
| `live_member_state` table | Per-member cooldown and chances                     |
| `~/.kotaete/auth/`        | WhatsApp auth sessions (Baileys, WWebJS)            |
| `~/.kotaete/state/`       | Daemon runtime state, plugin manifest, LID↔PN cache |

## Development

- **Formatter**: dprint (config in `dprint.jsonc` — tabs, single quotes, no semicolons)
- **TypeScript**: Strict mode enabled
- **Runtime**: Bun (>=1.3) — not Node.js
- **CLI Framework**: Crust.js
- **Database**: SurrealDB (>=2.0) for season scores and quiz event logging

## License

MIT
