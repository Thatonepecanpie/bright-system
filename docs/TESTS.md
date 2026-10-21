# Success tests

The build isn't done until these pass. Here is how each was exercised on the live project on 2026-10-21.

| # | Test | Result | How it was checked |
|---|---|---|---|
| 1 | Two agents claim the same task at once: only one wins. | **Pass** | Two agents fired claims on T-104 as two simultaneous HTTP requests (Postgres `pg_net`, same instant). One got `200 claimed`, the other `409 "T-104 is not claimable: status is in_progress (owner: test-a)"`. The event log shows exactly one `claimed`. The claim is a row-locked `UPDATE`; a unique index also makes a second simultaneous claim by one agent impossible. |
| 2 | Restart/redeploy: board, memory and messages are exactly as before. | **Pass (API redeploy)** | All state lives in Postgres; the API holds none. The API was deployed after the self-test data was written, and the owner snapshot through the new deployment returned those earlier tasks unchanged. A full database restart wasn't run, since it would mean pausing the project. |
| 3 | A task goes stale with no heartbeat: the Supervisor flags and requeues it. | **Pass** | Claimed T-101 with a 5-minute lease and forced the lease into the past. The sweep returned it to Ready, cleared the owner, added the `requeued_stale` flag and a note to its handoff, and messaged the project Supervisor. |
| 4 | A memory entry is corrected: the old one is marked superseded, not deleted. | **Pass** | Added memory #1, then #2 with `supersedes: 1`. #1 now has `superseded_by = 2`, `DELETE` on it is refused, rewriting it is refused, and briefings show only #2. |
| 5 | A scheduled sweep runs, completes, and requeues its next run with no duplicates. | **Pass** | `pg_cron` job `board-sweep` (every 5 minutes, the only job of that name) ran by itself at 20:15, 20:20 and 20:25 UTC, all `succeeded` in under 20 ms. Extra manual sweeps in the same window were skipped: one `sweep_runs` row per 5-minute window, enforced by a unique key. |
| 6 | Fernando adds a project and a task from his phone; an agent on another platform claims it on its next clock-in. | **Pass for API and UI separately; end-to-end on a real phone still pending** | Through the live API, an owner token created a task and a separate agent key claimed it with `claim-next` (T-105), then clocked out. The dashboard was driven in a 390×844 phone viewport (Playwright, mocked API): log in, board, open a gated task, approve, every tab, no horizontal page scroll. The claude.ai build was driven the same way with a mocked connector that answers in the real `execute_sql` format (this caught and fixed a parsing bug), and the exact query it sends was run once through the real connector. A real phone tap-through by Fernando is the last step. |

## Other rules checked (25 checks in the database self-test, all passing)

Second claim refused · non-holder can't edit an In Progress task · one task per agent · handoff note required to leave
In Progress · worker "done" goes to Review · Supervisor QA moves Review to Done · human gate routes Done to Needs Fernando ·
Supervisor can't approve a human gate · only Fernando can · password and card-number text rejected ·
worker-created tasks land in Backlog · paused agent turned away · bad key refused · event log can't be edited ·
Supervisor briefing lists duties.

Over HTTP against the live API: guide, health, missing key (401), Markdown briefing, update to Review,
message to Supervisor, OTP rejected (400), agent key refused on owner routes (401), claim-next, clock-out.

Self-test fixtures (`selftest` project, `test-*` agents) are archived, paused, and their keys voided.
