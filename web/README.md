# Kotaete Web — Live Quiz Spectator

SvelteKit web frontend that provides a real-time spectator view of running quizzes and season leaderboards. Reads data from SurrealDB (shared with the daemon).

## Architecture

```
SvelteKit (SSR + CSR)
 ├── SurrealDB client (server-side)
 │    ├── Query quiz_session, live_score, live_member_state, season, season_score
 │    └── LIVE SELECT on quiz_event, live_score, live_member_state for real-time updates
 ├── SSE endpoint (/api/live)
 │    └── Streams LIVE SELECT results to browser
 ├── Image endpoint (/api/image/[sessionId]/[questionNo])
 │    └── Serves question images from local quiz directories
 └── Pages
      └── / — Single-page dashboard
           ├── Top fold: Live question + image, winner display, countdown
           └── Bottom fold: Event history + season scoreboard
```

## Design Decisions

- **Vanilla CSS** — No Tailwind or CSS frameworks. Scoped component styles via Svelte.
- **Single-page dashboard** — Everything on `/`. No multi-page routing needed.
- **Season filter** — Only `kotaete-s*` seasons shown (official NIPBANG quizzes). `test-*` seasons are hidden.
- **Member display** — Uses `kananame` (Japanese name) + `classgroup` (組), matching WhatsApp message format.
- **Real-time images** — Question images served from local filesystem via API endpoint.
- **Winner display** — After a question is answered correctly, the winner is shown until the next question starts (or ~1 hour, then switches to countdown to next round/session).

## Dashboard Layout

```
┌─────────────────────────────────┐
│  🏆 Kotaete Live                │
│  kotaete-s3 — Round 1 🏞️       │
├─────────────────────────────────┤
│                                 │
│  [Current Question Image]       │
│  Q5: ＿ス                       │
│  ⏱ 45:23 remaining              │
│                                 │
│  ─── OR after correct answer ───│
│                                 │
│  ✅ タナカ (2組) — リス +8pts   │
│  🌸 Bonus: 栗鼠 +2pts           │
│                                 │
│  ─── OR after timeout ──────────│
│                                 │
│  ⏰ Time's up! Answer: リス      │
│                                 │
├─────────────────────────────────┤
│  Recent Activity                 │
│  ✅ タナカ (2組) correct +8      │
│  2️⃣  スズキ (3組) wrong (1 left) │
│  ✅ ヤマダ (1組) correct +10     │
│  ...                            │
├─────────────────────────────────┤
│  Season Scoreboard (kotaete-s3) │
│  1. タナカ 2組 — 150pts         │
│  2. スズキ 3組 — 120pts         │
│  3. ヤマダ 1組 — 95pts          │
│  ...                            │
└─────────────────────────────────┘
```

## Prerequisites

- SurrealDB instance running (shared with the daemon)
- Bun >= 1.3

## Implementation Plan

### Phase 2A: Project Scaffolding

- [ ] Initialize SvelteKit project in `web/` with TypeScript
- [ ] Configure `svelte.config.js`, `vite.config.ts`, `tsconfig.json`
- [ ] Add `surrealdb` dependency
- [ ] Set up vanilla CSS with Svelte scoped styles
- [ ] Add `package.json` scripts (`dev`, `build`, `preview`, `check`)

### Phase 2B: SurrealDB Client + API Routes

- [ ] Create `src/lib/server/surreal.ts` — SurrealDB connection singleton
- [ ] API routes:
  - `GET /api/active` — Current active quiz session (or null)
  - `GET /api/session/[id]` — Full session state (session + scores + member states)
  - `GET /api/image/[sessionId]/[questionNo]` — Serve question image from filesystem
  - `GET /api/season/[id]` — Season leaderboard (only `kotaete-s*` IDs)
  - `GET /api/seasons` — List seasons matching `kotaete-s*`
  - `GET /api/events/[sessionId]` — Recent events for a session

### Phase 2C: Real-time Updates (SSE + LIVE SELECT)

- [ ] Create `GET /api/live` — SSE endpoint
  - Subscribe to `LIVE SELECT * FROM quiz_event`
  - Subscribe to `LIVE SELECT * FROM live_score`
  - Subscribe to `LIVE SELECT * FROM live_member_state`
  - Subscribe to `LIVE SELECT * FROM quiz_session`
  - Stream events as SSE `data:` frames with event type classification
  - Handle connection cleanup on client disconnect
- [ ] Client-side EventSource hook (`src/lib/live-connection.ts`)
  - Connect to SSE endpoint
  - Parse events into typed state updates
  - Auto-reconnect with exponential backoff

### Phase 2D: Frontend Dashboard

- [ ] **Header** — App title, active season badge, connection status
- [ ] **Question card** — Current question with image, countdown timer, hint
- [ ] **Winner card** — Shown after correct answer with member name + points
- [ ] **Timeout card** — Shown after timeout with revealed answers
- [ ] **Countdown card** — Shown between questions/rounds with time to next event
- [ ] **Event history** — Scrollable feed of correct/wrong answers, sorted newest first
- [ ] **Season scoreboard** — Current `kotaete-s*` season leaderboard
- [ ] **God stage overlay** — Dramatic announcement for special questions

## SurrealDB Tables Used

The web frontend reads from these tables (written by the daemon's `QuizEventLogger`):

| Table               | Purpose                                              | LIVE SELECT?          |
| ------------------- | ---------------------------------------------------- | --------------------- |
| `quiz_session`      | Quiz session state (current question, round, status) | Yes (state changes)   |
| `quiz_event`        | Append-only event log (answers, timeouts, warnings)  | Yes (real-time feed)  |
| `live_score`        | Per-member score projection                          | Yes (live scoreboard) |
| `live_member_state` | Per-member transient state (cooldown, chances)       | Yes (member badges)   |
| `season`            | Season metadata                                      | No (static)           |
| `season_score`      | Cumulative season scores                             | No (poll on load)     |

## Event Types (from quiz_event)

| event_type            | Data fields                                                     |
| --------------------- | --------------------------------------------------------------- |
| `question_asked`      | hint, hasImage, imagePath, timeoutMs                            |
| `god_stage_asked`     | hint, hasImage, imagePath, timeoutMs                            |
| `answer_correct`      | matchedAnswer, gained, totalPoints, hasExtraPts, isSpecialStage |
| `answer_wrong`        | gained, totalPoints, remainingChances                           |
| `timeout`             | answers[]                                                       |
| `warning`             | extraHint                                                       |
| `cooldown`            | cooldownUntilMs                                                 |
| `god_stage_announced` | points, timeoutMinutes                                          |
| `quiz_finished`       | totalParticipants, finalScores                                  |
| `round_break`         | (none)                                                          |
| `special_duplicate`   | (none)                                                          |

## Development

```bash
cd web/
bun install
bun run dev        # Start dev server
bun run build      # Production build
bun run preview    # Preview production build
bun run check      # Type checking
```

## Environment Variables

| Variable            | Default                     | Description                       |
| ------------------- | --------------------------- | --------------------------------- |
| `SURREAL_ENDPOINT`  | `http://localhost:8000/rpc` | SurrealDB WebSocket/HTTP endpoint |
| `SURREAL_USERNAME`  | —                           | SurrealDB auth username           |
| `SURREAL_PASSWORD`  | —                           | SurrealDB auth password           |
| `SURREAL_NAMESPACE` | `medrivia`                  | SurrealDB namespace               |
| `SURREAL_DATABASE`  | `nipbang_kotaete`           | SurrealDB database                |
