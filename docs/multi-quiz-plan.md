# Multi-Quiz Per Group — Implementation Plan

## Problem

Currently, scheduling a new quiz in a group that already has an active quiz **force-ends the existing one**. This is enforced in `src/daemon/runtime.ts` at the relay handler level. The goal is to allow multiple quizzes to run concurrently in the same group (at different times).

## Root Causes

There are **four** distinct enforcement points:

| # | File         | Lines    | Mechanism                                                                                                                                                   |
| - | ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | `runtime.ts` | ~816–840 | `findJobByGroup()` + `forceEndJob()` on new quiz start                                                                                                      |
| 2 | `runtime.ts` | ~300–307 | Crash recovery deduplicates by `groupId` (keeps latest only)                                                                                                |
| 3 | `runtime.ts` | ~183–208 | Incoming messages broadcast to **all** jobs; each engine filters only by `groupId` — two engines with the same `groupId` would both accept the same answers |
| 4 | `runtime.ts` | ~663–749 | `season-stop` stops **all** jobs for a group and resets all season data                                                                                     |

Additionally, `season-store.ts` stores data keyed by `groupId` only, with no quiz-level granularity.

---

## Design Decisions

### Quiz Identity

Each quiz is already uniquely identified by its `jobId` (e.g., `q-1712345678901-1`). For user-facing references, `quizDir` (the source directory like `~/.kotaete/w20260405`) is the natural identifier. The plan uses `quizDir` as the user-facing handle and `jobId` as the internal key.

### Season Scoping

Season data should remain **per-group** (not per-quiz). Multiple quizzes in the same group contribute to the same season leaderboard. This matches the real-world use case: a "season" spans all quizzes in a group over a period. The `season.start` flag on a quiz bundle should reset the group's season data only when explicitly set — this behavior stays the same.

### Message Routing

When two quizzes run in the same group, incoming WhatsApp messages must be routed to **only the quiz that is currently accepting answers**. If both quizzes are accepting answers simultaneously (overlapping schedules), the message should go to the quiz whose question was sent most recently (or the one with the earliest deadline). In practice, overlapping quizzes should be rare and the config author is responsible for non-overlapping schedules.

---

## Changes by File

### 1. `src/daemon/runtime.ts`

#### 1a. Remove force-end on new quiz start

**Current** (relay handler, `run-quiz` type):

```typescript
const existingGroupJob = this.findJobByGroup(resolvedGroupId)
if (existingGroupJob) {
	log.info(
		`force-ending existing job ${existingGroupJob.id} for group ${resolvedGroupId}`,
	)
	await this.forceEndJob(existingGroupJob.id)
}
```

**Change**: Remove the `findJobByGroup` check and `forceEndJob` call entirely. Allow the new quiz to start alongside existing ones.

#### 1b. Replace `findJobByGroup()` with `findJobsByGroup()`

**Current**:

```typescript
private findJobByGroup(groupId: string): JobRecord | undefined {
    for (const job of this.jobs.values()) {
        if (job.meta.groupId === groupId) return job
    }
    return undefined
}
```

**Change**: Replace with:

```typescript
private findJobsByGroup(groupId: string): JobRecord[] {
    return [...this.jobs.values()].filter(j => j.meta.groupId === groupId)
}
```

Update all callers:

- `quiz-stop` handler: already iterates all jobs when no `id` is given — use `findJobsByGroup()` for the group-filtered variant
- `season-stop` handler: already filters by `groupId` — use `findJobsByGroup()` directly

#### 1c. Fix crash recovery deduplication

**Current**:

```typescript
const deduped = new Map<string, ...>()
for (const entry of parsed.jobs) {
    const prev = deduped.get(entry.groupId)
    if (!prev || entry.createdAt > prev.createdAt) {
        deduped.set(entry.groupId, entry)
    }
}
```

**Change**: Remove groupId-based deduplication entirely. Jobs are already uniquely keyed by `jobId` in the persisted snapshot. Simply restore all jobs:

```typescript
for (const entry of parsed.jobs) {
	// recover each job independently
}
```

#### 1d. Route incoming messages by active quiz context

**Current**:

```typescript
onIncoming: ;
;(async (incoming) => {
	const jobs = [...this.jobs.values()]
	for (const job of jobs) {
		await job.engine.onIncomingMessage(incoming)
	}
})
```

**Change**: Filter to only jobs whose engine is currently accepting answers for the incoming message's group:

```typescript
onIncoming: ;
;(async (incoming) => {
	const jobs = [...this.jobs.values()].filter(
		j => j.meta.groupId === incoming.groupId && j.engine.isRunning(),
	)
	// If multiple quizzes are accepting answers, route to the one
	// with the most recent question (highest index). This is a
	// pragmatic choice — overlapping schedules are a config error.
	const acceptingJobs = jobs.filter(j =>
		j.engine.isAcceptingAnswers?.() ?? false
	)
	const targets = acceptingJobs.length > 0 ? acceptingJobs : jobs
	for (const job of targets) {
		await job.engine.onIncomingMessage(incoming)
	}
})
```

This requires adding `isAcceptingAnswers()` to `QuizEngine` (see §2).

#### 1e. Update `season-stop` handler

**Current**: Stops all jobs for the group and resets all season data.

**Change**: Keep the current behavior (stop all quizzes in the group, reset group season). This is correct for the "end the season" use case. If per-quiz season stopping is needed later, add a `--quiz` flag.

### 2. `src/quiz/engine.ts`

#### 2a. Add `isAcceptingAnswers()` public method

**Add**:

```typescript
isAcceptingAnswers(): boolean {
    return this.state?.acceptingAnswers === true
}
```

This is used by the runtime's incoming message router (§1d) to determine which quiz should receive answers.

#### 2b. No other engine changes needed

The engine already has a 1:1 relationship with `JobRecord`. Each instance is independent. The `groupId` filter in `onIncomingMessage` (line ~313) already drops messages for the wrong group.

### 3. `src/quiz/season-store.ts`

**No changes needed.** Season data remains per-group. Multiple quizzes in the same group accumulate into the same season pool. The `season.start` flag on a quiz bundle resets the group's season data — this is intentional and stays as-is.

### 4. `src/cli/commands/quiz.ts`

**No changes needed.** The `quiz stop` command already handles multiple jobs gracefully (prompts for selection when multiple exist). The `quiz status` command already lists all jobs with `groupId` and `quizDir`.

### 5. `src/cli/commands/season.ts`

**No changes needed for v1.** The `season stop` command stops all quizzes in a group and resets season data — this is the correct behavior for ending a season. Future enhancement: add `--quiz <dir>` flag to stop a specific quiz's season tracking without affecting others.

### 6. `src/daemon/protocol.ts`

**No changes needed.** The `relayRunRequestSchema` already has all fields needed (`sources`, `quizDir`, `groupId`). The `relayStopSeasonRequestSchema` works at the group level, which is correct.

---

## Implementation Order

1. **`engine.ts`** — Add `isAcceptingAnswers()` public method (~3 lines)
2. **`runtime.ts`** — Remove force-end constraint, replace `findJobByGroup`, fix recovery dedup, update incoming message routing
3. **Test** — Add integration test: schedule two quizzes in the same group, verify both run independently, verify answers go to the correct quiz
4. **Manual verification** — Run `bun run daemon`, schedule two quizzes with different `quizDir` but same `groupId`, verify both appear in `quiz status`, verify answers are routed correctly

## Risk Assessment

| Risk                                                              | Likelihood | Mitigation                                                                           |
| ----------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| Two quizzes accept answers simultaneously (overlapping schedules) | Medium     | Route to most-recent-question quiz; log a warning                                    |
| Season data collision (two quizzes with `season.start: true`)     | Low        | Config author responsibility; last-start-wins behavior is acceptable                 |
| Crash recovery loads stale jobs                                   | Low        | Jobs are keyed by unique `jobId`; stale jobs self-terminate when their timers expire |
| Increased memory with many concurrent quizzes                     | Low        | Quizzes are short-lived; jobs are removed on completion                              |

## Testing Plan

1. **Unit test**: `isAcceptingAnswers()` returns correct state
2. **Unit test**: Recovery restores multiple jobs for the same group
3. **Integration test**: Two quizzes in same group, answers routed to active one
4. **Integration test**: `quiz status` shows both quizzes with correct `quizDir`
5. **Integration test**: `quiz stop <id>` stops only the targeted quiz
