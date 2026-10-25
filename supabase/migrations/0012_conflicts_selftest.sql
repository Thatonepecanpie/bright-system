-- Self-test for conflicts, hand-over and the consistency check. Runs on throwaway rows and always
-- rolls back by raising at the end: `select board._selftest_conflicts()` reports PASS/FAIL lines.
create or replace function board._selftest_conflicts() returns void
language plpgsql set search_path = '' as $$
declare
  out  text[] := '{}';
  pid  bigint;
  t1   bigint; t2 bigint; t3 bigint;
  a    board.agents; b board.agents; s board.agents;
  c    jsonb; r jsonb;
  st   text; ok boolean;
  ck   jsonb;
begin
  update board.agents set status = 'active', retired_at = null where id in ('test-a', 'test-b', 'test-s');
  select * into a from board.agents where id = 'test-a';
  select * into b from board.agents where id = 'test-b';
  select * into s from board.agents where id = 'test-s';
  insert into board.projects (slug, name, supervisor) values ('zz-conflict-test', 'Conflict test', 'test-s') returning id into pid;
  insert into board.assignment_rows (project_id, agent_id, role) values (pid, 'test-a', 'researcher'), (pid, 'test-b', 'researcher');

  insert into board.tasks (project_id, title, created_by, assignee, status) values (pid, 'Conflict target', 'fernando', 'test-a', 'ready') returning id into t1;
  c := board._flag_conflict(b, 'selftest', jsonb_build_object('task', 'T-' || t1, 'about', 'Which version is current',
         'source_a', 'Files: notes.md says 0.1.21', 'source_b', 'Memory #9 says 0.1.43'));
  select status into st from board.tasks where id = t1;
  out := out || format('%s flag blocks task and goes to supervisor (%s, %s)', case when st = 'blocked' and c ->> 'decide' = 'supervisor' then 'PASS' else 'FAIL' end, st, c ->> 'decide');

  begin
    perform board._resolve_conflict('test-a', 'selftest', jsonb_build_object('id', c ->> 'id', 'resolution', 'A is right'), false);
    out := out || 'FAIL non-supervisor could resolve'::text;
  exception when others then out := out || ('PASS non-supervisor refused: ' || sqlerrm); end;

  r := board._resolve_conflict('test-s', 'selftest', jsonb_build_object('id', c ->> 'id', 'resolution', '0.1.43 is current; notes.md is an old snapshot.'), false);
  select status into st from board.tasks where id = t1;
  select exists (select 1 from board.memory where id = (r ->> 'memory_id')::bigint and project_id = pid and kind = 'decision') into ok;
  out := out || format('%s supervisor resolves: memory saved, task back to %s', case when ok and st = 'ready' and r ->> 'status' = 'resolved' then 'PASS' else 'FAIL' end, st);

  c := board._flag_conflict(b, 'selftest', jsonb_build_object('project', 'zz-conflict-test', 'about', 'Pricing direction',
         'source_a', 'Old doc: $19 one-time', 'source_b', 'Chat: subscription', 'for', 'fernando'));
  begin
    perform board._resolve_conflict('test-s', 'selftest', jsonb_build_object('id', c ->> 'id', 'resolution', 'one-time'), false);
    out := out || 'FAIL supervisor resolved a Fernando conflict'::text;
  exception when others then out := out || 'PASS Fernando-only conflict refused for supervisor'::text; end;
  r := board._resolve_conflict('fernando', 'selftest', jsonb_build_object('id', c ->> 'id', 'resolution', 'One-time $19 for now.'), true);
  out := out || format('%s Fernando resolves', case when r ->> 'status' = 'resolved' then 'PASS' else 'FAIL' end);

  insert into board.tasks (project_id, title, created_by, assignee, status) values (pid, 'Assigned ready', 'fernando', 'test-a', 'ready') returning id into t2;
  insert into board.tasks (project_id, title, created_by, assignee, owner, status, handoff_note, lease_expires_at)
    values (pid, 'Half done', 'fernando', 'test-a', 'test-a', 'in_progress', 'Did steps 1-2.', now() + interval '1 hour') returning id into t3;
  update board.assignment_rows set removed_at = now() where project_id = pid and agent_id = 'test-a';
  r := board._handover(pid, 'test-a', 'selftest');
  select (select assignee is distinct from 'test-a' from board.tasks where id = t2)
     and (select status = 'ready' and owner is null and assignee is distinct from 'test-a' and handoff_note like 'Did steps 1-2.%Released%' from board.tasks where id = t3)
    into ok;
  out := out || format('%s hand-over moved %s tasks: %s', case when ok and jsonb_array_length(r) = 3 then 'PASS' else 'FAIL' end, jsonb_array_length(r), r::text);

  ck := board.consistency_check();
  select exists (select 1 from board.tasks where project_id = pid and title = 'Weekly consistency check' and assignee = 'test-s') into ok;
  r := board.consistency_check();
  out := out || format('%s weekly check created for supervisor, not duplicated (%s then %s)',
    case when ok and (select count(*) from board.tasks where project_id = pid and title = 'Weekly consistency check') = 1 then 'PASS' else 'FAIL' end, ck, r);

  raise exception 'SELFTEST (rolled back): %', array_to_string(out, ' || ');
end $$;
