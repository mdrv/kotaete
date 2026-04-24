# Kotaete Web — Live Quiz Spectator

SvelteKit web frontend that provides a real-time spectator view of running quizzes and season leaderboards. Reads data from SurrealDB (shared with the daemon) via REST API + WebSocket live updates.

## Architecture

```
SvelteKit (SSR + CSR)
 ├── SurrealDB client (server-side)
 │    ├── REST queries for initial data load
 │    └── LIVE SELECT on 5 tables for real-time updates
 ├── WebSocket endpoint (/api/ws)
 │    ├── Shared SurrealDB live subscriptions (broadcast to all clients)
 │    ├── Viewer count tracking (connect/disconnect)
 │    └── Bidirectional messaging (extensible for future chat)
 ├── Image endpoint (/api/image/[sessionId]/[questionNo])
 │    └── Serves question images from local quiz directories
 └── Pages
      └── / — Single-page dashboard
           ├── Top fold: Live question + image, winner display, countdown
           ├── Bottom fold: Live scores (with cooldown), event history + season scoreboard
           └── Header: Connection status (LIVE dot + viewer count), theme toggle
```

## Design Decisions

- **WebSocket** (not SSE) — Bidirectional, single shared SurrealDB subscription set broadcast to all clients. Viewer count demonstrates bidirectional capability.
- **`ws` package + Vite `configureServer`** — WebSocket upgrade via Vite plugin hook on `httpServer`. Production uses custom `server.ts` wrapper with `@sveltejs/adapter-node`.
- **Vanilla CSS** — No Tailwind or CSS frameworks. Scoped component styles via Svelte.
- **Single-page dashboard** — Everything on `/`. No multi-page routing needed.
- **Season filter** — Only `kotaete-s*` seasons shown (official NIPBANG quizzes). `test-*` seasons are hidden.
- **Server clock sync** — Computes `clockOffset` from HTTP `Date` header for accurate countdowns across clock drift.
- **RecordId normalization** — SurrealDB `RecordId` objects are recursively converted to `"table:id"` strings before WebSocket broadcast to avoid JSON serialization issues.
- **Member display** — Uses `kananame` (Japanese name) + `classgroup` (組), matching WhatsApp message format.
- **Real-time images** — Question images served from local filesystem via API endpoint.
- **Finished session handling** — Finished/stopped sessions remain visible with final scores until a new session starts (no aggressive cleanup).

## Dashboard Layout

```
┌─────────────────────────────────┐
│  🏆 Kotaete Live        🟢 LIVE │
│  kotaete-s3 — Round 1 🏞️  👥 3 │
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
│  ─── OR after quiz finished ────│
│                                 │
│  🏁 Quiz Finished!              │
│  🏆 150pts — タナカ (2組)       │
│                                 │
├────────────────┬────────────────┤
│ Live Scores    │ Event History  │
│ 1. タナカ ⏳1:45│ ✅ タナカ +8   │
│    150pts      │ 2️⃣ スズキ wrong│
│ 2. スズキ      │ ⏰ Q5 timed out│
│    120pts      │ ...            │
│ ...            │                │
├────────────────┤                │
│ Season Board   │                │
│ 1. タナカ 150  │                │
│ 2. スズキ 120  │                │
│ ...            │                │
└────────────────┴────────────────┘
```

## Key Source Files

```
web/src/
├── lib/
│   ├── components/
│   │   └── Dashboard.svelte    # Main dashboard UI + WS event handling
│   ├── server/
│   │   ├── surreal.ts          # SurrealDB connection singleton
│   │   ├── ws-handler.ts       # KotaeteWsServer (shared subs, broadcast, viewer count)
│   │   └── logger.ts           # Structured logging (logtape)
│   ├── live-connection.ts      # WebSocket client with reconnect + callbacks
│   └── types.ts                # TypeScript interfaces (QuizSession, LiveScore, etc.)
├── routes/
│   ├── api/
│   │   ├── active/+server.ts   # REST: current session + scores + member states
│   │   ├── seasons/+server.ts  # REST: season list
│   │   ├── season/[id]/+server.ts  # REST: season scores
│   │   ├── events/[id]/+server.ts  # REST: session event history
│   │   └── image/[id]/[q]/+server.ts # REST: question images
│   └── +page.svelte            # Page wrapper
├── server.ts                   # Production HTTP server (adapter-node wrapper)
├── vite.config.ts              # Vite + WS plugin (configureServer + configurePreviewServer)
└── svelte.config.js            # adapter-node
```

## Prerequisites

- SurrealDB instance running (shared with the daemon)
- Bun >= 1.3.12 (WebSocket fixes)

## Development

```bash
cd web/
bun install
bun run dev          # Start dev server (includes WS via Vite plugin)
bun run build        # Production build
bun run start        # Run production server (custom server.ts)
bun run check        # Type checking
bun run fmt          # Format code
```

## Environment Variables

| Variable            | Default              | Description                  |
| ------------------- | -------------------- | ---------------------------- |
| `SURREAL_ENDPOINT`  | `ws://localhost:596` | SurrealDB WebSocket endpoint |
| `SURREAL_USERNAME`  | —                    | SurrealDB auth username      |
| `SURREAL_PASSWORD`  | —                    | SurrealDB auth password      |
| `SURREAL_NAMESPACE` | `medrivia`           | SurrealDB namespace          |
| `SURREAL_DATABASE`  | `nipbang_kotaete`    | SurrealDB database           |
| `PORT`              | `3000`               | Production server port       |
