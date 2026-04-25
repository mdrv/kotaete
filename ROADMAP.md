# ROADMAP: Crash Recovery Hardening

## Goal

Make quiz runtime recovery deterministic, auditable, and resilient to partial failures while reducing single points of failure.

## Priority 0 (Immediate) ✅

- [x] Add idempotent state transitions for recovery-sensitive operations:
  - `finishQuiz()` has `quizFinalized` guard — returns early on repeat calls.
  - Timeout/correct handlers check `acceptingAnswers` before processing.
- [x] Persist and verify checkpoint write ACK path:
  - `checkpointSaveCount`/`checkpointFailCount` counters in QuizEngine.
  - Write latency measured, error-level alert after 3+ consecutive failures.
- [x] Add startup integrity check:
  - `validateConsistency()` checks orphaned checkpoints and mid-question state.
  - Orphaned checkpoints are auto-deleted.
  - Called before `recoverJobs()`.

## Priority 1 (Short Term)

- [x] Introduce monotonic checkpoint revisions:
  - Added `rev` (monotonic int) and `source` to checkpoint payload and schema.
  - `saveCheckpoint()` rejects stale writes via `IF $existing[0].rev < $rev`.
- [x] Add recovery journaling events:
  - `recover_begin`, `recover_checkpoint_loaded`, `recover_done` log events.
- [ ] Add integrity watchdog:
  - Periodically verify that active in-memory job state matches SurrealDB projections.
- [ ] Add safer event logger session lifecycle:
  - Record explicit `session_reactivated` and `session_reactivation_failed` events.
  - Auto-create replacement session with linkage to old session ID.

## Data Model Enhancements

- [x] `daemon_checkpoint`: Added `rev`, `source` columns.
- [x] `daemon_job`: Added `status`, `last_heartbeat_at` columns. Lifecycle transitions wired (queued→running→done).
- [ ] `quiz_event`: Add canonical recovery event taxonomy and correlation IDs.

## Priority 2 (Reliability Engineering)

- Add fault-injection tests:
  - Simulate crash after checkpoint save, before send.
  - Simulate crash after send, before checkpoint save.
  - Simulate SurrealDB transient failures during answer processing.
- Add end-to-end daemon recovery tests:
  - Boot daemon, run quiz mid-question, force restart, verify exact phase resume.
  - Validate no duplicate scoring after restart.
- Add chaos/retry policy matrix:
  - Explicit retry budgets per operation (checkpoint save, session update, score upsert).
  - Circuit-breaker behavior for repeated DB failures.

## Priority 3 (Operational Hardening)

- Add dead letter handling for critical DB writes:
  - Persist failed critical writes to a retry queue table.
  - Replay queue on daemon startup.
- Add observability SLOs:
  - Checkpoint persistence success rate.
  - Recovery success rate.
  - Mean recovery completion time.
- Add runbook and on-call playbook:
  - Recovery failure diagnostics.
  - Manual session repair workflow.
  - Data consistency repair scripts.

## Safety Guards

- Never mutate scores without an associated durable event/log entry.
- Never advance question token without checkpoint write attempt logged.
- Never finish session without final state write attempt and outcome logged.

## Success Criteria

- Crash during any point of question lifecycle resumes without score duplication.
- Recovery path is deterministic and reproducible from persisted state.
- Critical write failure is visible, retryable, and does not silently corrupt flow.
