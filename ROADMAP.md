# ROADMAP: Crash Recovery Hardening

## Goal

Make quiz runtime recovery deterministic, auditable, and resilient to partial failures while reducing single points of failure.

## Priority 0 (Immediate)

- Add idempotent state transitions for recovery-sensitive operations:
  - Ensure `finishQuiz()` can be retried safely after partial failure.
  - Ensure timeout/correct handlers are no-op-safe when replayed.
- Persist and verify checkpoint write ACK path:
  - Include write latency and result status in logs.
  - Alert on repeated checkpoint save failures in the same session.
- Add startup integrity check:
  - Validate `daemon_job` and `daemon_checkpoint` consistency before recover.
  - Quarantine invalid rows instead of silently skipping.

## Priority 1 (Short Term)

- Introduce monotonic checkpoint revisions:
  - Add `rev` and `saved_at` to checkpoint payload.
  - Reject stale checkpoint writes (`rev` regression).
- Add recovery journaling events:
  - `recover_begin`, `recover_job_loaded`, `recover_checkpoint_loaded`, `recover_resume_started`, `recover_resume_failed`, `recover_done`.
- Add integrity watchdog:
  - Periodically verify that active in-memory job state matches SurrealDB projections.
- Add safer event logger session lifecycle:
  - Record explicit `session_reactivated` and `session_reactivation_failed` events.
  - Auto-create replacement session with linkage to old session ID.

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

## Data Model Enhancements

- `daemon_checkpoint`:
  - Add `rev`, `saved_at`, `source` (`question_send`, `correct_answer`, `timeout`).
- `daemon_job`:
  - Add `status`, `last_heartbeat_at`, `recovery_attempts`.
- `quiz_event`:
  - Add canonical recovery event taxonomy and correlation IDs.

## Safety Guards

- Never mutate scores without an associated durable event/log entry.
- Never advance question token without checkpoint write attempt logged.
- Never finish session without final state write attempt and outcome logged.

## Success Criteria

- Crash during any point of question lifecycle resumes without score duplication.
- Recovery path is deterministic and reproducible from persisted state.
- Critical write failure is visible, retryable, and does not silently corrupt flow.
