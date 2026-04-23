# Kotaete Web — Live Quiz Spectator

SvelteKit web frontend that provides a real-time spectator view of running quizzes, season leaderboards, and quiz history. Reads data from SurrealDB (shared with the daemon).

## Architecture

```
SvelteKit (SSR + CSR)
 ├── SurrealDB client (server-side)
 │    ├── Query quiz_session, live_score, live_member_state
 │    └── LIVE SELECT on quiz_event for real-time updates
 ├── SSE endpoint (/api/quiz/[id]/live)
 │    └── Streams quiz_event LIVE SELECT results to browser
 └── Pages
      ├── / — Dashboard (active quizzes, upcoming schedule)
      ├── /quiz/[id] — Live quiz view (scoreboard, current question, timer)
      ├── /season/[id] — Season leaderboard
      └── /history — Past quiz sessions
```

## Prerequisites

- SurrealDB instance running (shared with the daemon)
- Node.js >= 18 or Bun >= 1.3

## Implementation Plan

### Phase 2A: Project Scaffolding

- [ ] Initialize SvelteKit project in `web/` with TypeScript
- [ ] Configure `svelte.config.js`, `vite.config.ts`, `tsconfig.json`
- [ ] Add `surrealdb` dependency
- [ ] Set up Tailwind CSS (or preferred styling)
- [ ] Add `package.json` scripts (`dev`, `build`, `preview`, `check`)

### Phase 2B: SurrealDB Client + API Routes

- [ ] Create `src/lib/server/surreal.ts` — SurrealDB connection singleton
- [ ] Create `src/lib/server/schema.ts` — Typed queries for reading quiz state
- [ ] API routes:
  - `GET /api/quiz/active` — List active quiz sessions
  - `GET /api/quiz/[id]` — Full session state (session + scores + member states)
  - `GET /api/season/[id]` — Season leaderboard
  - `GET /api/history` — Past quiz sessions (paginated)

### Phase 2C: Real-time Updates (SSE + LIVE SELECT)

- [ ] Create `GET /api/quiz/[id]/live` — SSE endpoint
  - Subscribe to `LIVE SELECT * FROM quiz_event WHERE session_id = $sid`
  - Also subscribe to `LIVE SELECT * FROM live_score WHERE session_id = $sid`
  - Also subscribe to `LIVE SELECT * FROM live_member_state WHERE session_id = $sid`
  - Stream events as SSE `data:` frames with event type classification
  - Handle connection cleanup on client disconnect
- [ ] Client-side EventSource hook (`src/lib/hooks/useQuizLive.ts`)
  - Connect to SSE endpoint
  - Parse events into typed state updates
  - Auto-reconnect with exponential backoff
- [ ] Consider WebSocket alternative if SSE proves insufficient

### Phase 2D: Frontend Pages

- [ ] **Dashboard (`/`)** — Active quizzes, upcoming schedule, season overview
- [ ] **Live Quiz (`/quiz/[id]`)** — Real-time view with:
  - Current question display (text, image, hint)
  - Countdown timer (deadline)
  - Live scoreboard (sorted by points, animated on change)
  - Per-member status (cooldown badge, remaining chances)
  - Answer feed (correct ✅, wrong 2️⃣1️⃣, timeout ⏰)
  - God stage announcement overlay
- [ ] **Season Leaderboard (`/season/[id]`)** — Cumulative scores with member details
- [ ] **History (`/history`)** — Past sessions with final scoreboards

### Phase 2E: Polish

- [ ] Responsive design (mobile-friendly for on-the-go viewing)
- [ ] Dark/light theme
- [ ] Connection status indicator (SurrealDB health)
- [ ] Error boundaries and loading states
- [ ] OG meta tags for share previews

## SurrealDB Tables Used

The web frontend reads from these tables (written by the daemon's `QuizEventLogger`):

| Table               | Purpose                                              | LIVE SELECT?          |
| ------------------- | ---------------------------------------------------- | --------------------- |
| `quiz_session`      | Quiz session state (current question, round, status) | No (poll on load)     |
| `quiz_event`        | Append-only event log (answers, timeouts, warnings)  | Yes (real-time feed)  |
| `live_score`        | Per-member score projection                          | Yes (live scoreboard) |
| `live_member_state` | Per-member transient state (cooldown, chances)       | Yes (member badges)   |
| `season`            | Season metadata                                      | No (static)           |
| `season_score`      | Cumulative season scores                             | No (poll on load)     |

## Event Types (from quiz_event)

| event_type            | Description                      |
| --------------------- | -------------------------------- |
| `question_asked`      | New question sent                |
| `answer_correct`      | Member answered correctly        |
| `answer_wrong`        | Member answered wrong            |
| `timeout`             | Question timed out               |
| `warning`             | 10-minute warning before timeout |
| `cooldown`            | Member tried during cooldown     |
| `god_stage_announced` | God stage incoming announcement  |
| `god_stage_asked`     | God stage question sent          |
| `quiz_finished`       | Quiz completed                   |
| `round_break`         | Break between rounds             |
| `special_duplicate`   | Duplicate attempt in god stage   |

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
