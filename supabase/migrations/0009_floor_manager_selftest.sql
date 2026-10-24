-- Re-runnable self-test of the Floor Manager: select board._selftest_manager();
-- It works on test agents, reports its findings in the error message, and the error rolls everything back.
-- Expected (2026-10-24): routing writing -> writer, coding -> coder, explicit skills win; a 4-task pile-up
-- suggests "every 2 hours" for 3 days; request -> approve (changed) -> FIRST in briefing -> confirm ->
-- expire -> revert -> confirm; too-fast / reasonless requests and foreign profile edits refused; pausing the
-- coder reroutes its waiting work; the old entry points are closed to anon.
-- Body: see the function as applied (create or replace function board._selftest_manager ...).

-- Live API checks use board._livetest(true) (activates test-a, returns a fresh key) and board._livetest(false)
-- (voids test keys, cancels their pending requests). Neither is callable from the API.
