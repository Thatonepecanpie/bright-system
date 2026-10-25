-- Conflicts, hand-over on removal, the weekly consistency check, and custom sprites.
--   * Any agent that finds two sources disagreeing flags a conflict: the task it blocks waits, the
--     project Supervisor (or Fernando, for direction, money or legal calls) decides, and the decision
--     becomes a Memory entry so it never comes up again.
--   * Removing an agent from a team hands its open work in that project to the Floor Manager.
--   * Every week each active project's Supervisor gets a consistency-check task.
--   * Fernando can give an agent a custom sprite (a small image, kept out of agent briefings).

create table if not exists board.avatars (
  agent_id   text primary key references board.agents(id),
  image      text not null check (image ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' and length(image) <= 150000),
  updated_at timestamptz not null default now()
);
alter table board.avatars enable row level security;
revoke all on board.avatars from public, anon, authenticated;

create table if not exists board.conflicts (
  id          bigint generated always as identity primary key,
  project_id  bigint references board.projects(id),
  task_id     bigint references board.tasks(id),
  raised_by   text not null,
  about       text not null check (length(about) between 3 and 300),
  source_a    text not null check (length(source_a) between 3 and 2000),
  source_b    text not null check (length(source_b) between 3 and 2000),
  decide      text not null default 'supervisor' check (decide in ('supervisor', 'fernando')),
  status      text not null default 'open' check (status in ('open', 'resolved')),
  resolution  text not null default '',
  resolved_by text,
  memory_id   bigint,
  task_was    text,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists conflicts_open on board.conflicts (status, project_id);
alter table board.conflicts enable row level security;
revoke all on board.conflicts from public, anon, authenticated;

-- ---------- conflicts ----------

create or replace function board._flag_conflict(a board.agents, p_via text, p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  t     board.tasks;
  pid   bigint;
  sup   text;
  dec   text;
  who   text;
  c     board.conflicts;
  about text := trim(coalesce(p ->> 'about', ''));
  sa    text := trim(coalesce(p ->> 'source_a', ''));
  sb    text := trim(coalesce(p ->> 'source_b', ''));
begin
  if length(about) < 3 or length(sa) < 3 or length(sb) < 3 then
    raise exception 'Give about (what the disagreement is), source_a and source_b (what each source says, and where it is).'
      using errcode = 'PT400';
  end if;
  perform board._check_secrets(about || ' ' || sa || ' ' || sb);
  if coalesce(p ->> 'task_id', p ->> 'task', p ->> 'id', '') <> '' then
    select * into t from board.tasks
    where id = board._task_id(jsonb_build_object('id', coalesce(p ->> 'task_id', p ->> 'task', p ->> 'id'))) for update;
    if not found then
      raise exception 'Task not found.' using errcode = 'PT404';
    end if;
    pid := t.project_id;
  elsif nullif(p ->> 'project', '') is not null then
    pid := board._project_id(p ->> 'project');
  end if;
  if pid is not null and not board._can_access_project(a.id, pid) then
    raise exception 'You are not on that project.' using errcode = 'PT403';
  end if;

  select supervisor into sup from board.projects where id = pid;
  dec := case when lower(coalesce(p ->> 'for', '')) = 'fernando' or sup is null or sup = a.id then 'fernando' else 'supervisor' end;
  who := case dec when 'fernando' then 'fernando' else sup end;

  insert into board.conflicts (project_id, task_id, raised_by, about, source_a, source_b, decide, task_was)
  values (pid, t.id, a.id, left(about, 300), left(sa, 2000), left(sb, 2000), dec, t.status)
  returning * into c;

  -- The task it affects waits for the decision instead of being built on a guess.
  if t.id is not null and t.status in ('ready', 'in_progress') then
    update board.tasks set status = 'blocked', status_changed_at = now(), lease_expires_at = null,
      next_action = left(format('Waiting on conflict #%s: %s', c.id, about), 500), updated_at = now()
    where id = t.id;
  end if;

  perform board._log(a.id, p_via, pid, t.id, 'conflict_flagged', jsonb_build_object('conflict', c.id, 'decide', dec));
  perform board._system_msg(pid, t.id, who, format(
    'Conflict #%s from %s: %s. Source A: %s | Source B: %s. %s', c.id, a.display_name, about, sa, sb,
    case dec when 'fernando' then 'Fernando decides on the dashboard.' else 'Decide with resolve_conflict (id, resolution).' end));
  return to_jsonb(c) || jsonb_build_object('notice', format('Conflict #%s goes to %s.%s', c.id, who,
    case when t.id is not null and t.status in ('ready', 'in_progress') then format(' T-%s is Blocked until it is decided.', t.id) else '' end));
end $$;

create or replace function board._resolve_conflict(p_actor text, p_via text, p jsonb, p_is_owner boolean) returns jsonb
language plpgsql set search_path = '' as $$
declare
  c    board.conflicts;
  t    board.tasks;
  m    jsonb;
  res  text := trim(coalesce(p ->> 'resolution', ''));
  cid  bigint := nullif(regexp_replace(coalesce(p ->> 'id', p ->> 'conflict', ''), '\D', '', 'g'), '')::bigint;
begin
  select * into c from board.conflicts where id = cid for update;
  if not found then
    raise exception 'Conflict #% not found.', cid using errcode = 'PT404';
  end if;
  if c.status <> 'open' then
    raise exception 'Conflict #% is already resolved.', c.id using errcode = 'PT409';
  end if;
  if not p_is_owner and not (c.decide = 'supervisor' and board._is_sup(p_actor, c.project_id)) then
    raise exception 'Only % can decide conflict #%.', case c.decide when 'fernando' then 'Fernando' else 'the project Supervisor' end, c.id
      using errcode = 'PT403';
  end if;
  if length(res) < 3 then
    raise exception 'Write the resolution: which source is right, and what everyone should do from now on.' using errcode = 'PT400';
  end if;

  -- The decision becomes a Memory entry so nobody has to ask again.
  m := board._add_memory(p_actor, p_via, jsonb_build_object(
    'project', (select slug from board.projects where id = c.project_id),
    'kind', 'decision', 'title', left('Resolved: ' || c.about, 200), 'body', left(res, 4000),
    'supersedes', p ->> 'supersedes', 'source_task_id', c.task_id), p_is_owner);

  update board.conflicts set status = 'resolved', resolution = left(res, 4000), resolved_by = p_actor,
    resolved_at = now(), memory_id = (m ->> 'id')::bigint
  where id = c.id returning * into c;

  select * into t from board.tasks where id = c.task_id for update;
  if found and t.status = 'blocked' and t.next_action like format('Waiting on conflict #%s:%%', c.id) then
    update board.tasks set status = 'ready', owner = null, status_changed_at = now(),
      flags = array_remove(flags, 'long_blocked'),
      next_action = left(format('Conflict #%s decided (memory #%s): %s', c.id, c.memory_id, res), 500), updated_at = now()
    where id = t.id;
  end if;

  perform board._log(p_actor, p_via, c.project_id, c.task_id, 'conflict_resolved', jsonb_build_object('conflict', c.id, 'memory_id', c.memory_id));
  perform board._system_msg(c.project_id, c.task_id, c.raised_by,
    format('Conflict #%s (%s) was decided by %s: %s (saved as memory #%s).', c.id, c.about, p_actor, res, c.memory_id));
  return to_jsonb(c);
end $$;

create or replace function board._open_conflicts(p_agent text) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('project', p.slug) order by c.id), '[]')
  from board.conflicts c left join board.projects p on p.id = c.project_id
  where c.status = 'open'
    and (p_agent is null or c.raised_by = p_agent or (c.decide = 'supervisor' and p.supervisor = p_agent))
$$;

-- ---------- hand-over when an agent leaves a team ----------

create or replace function board._handover(p_project bigint, p_agent text, p_via text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  t     board.tasks;
  r     jsonb;
  moved jsonb := '[]';
  name  text := coalesce((select display_name from board.agents where id = p_agent), p_agent);
begin
  for t in select * from board.tasks
           where project_id = p_project and status not in ('done', 'review', 'needs_fernando')
             and (assignee = p_agent or owner = p_agent)
           order by id for update loop
    update board.tasks set
      assignee = case when assignee = p_agent then null else assignee end,
      owner = case when owner = p_agent then null else owner end,
      status = case when status = 'in_progress' then 'ready' else status end,
      status_changed_at = case when status = 'in_progress' then now() else status_changed_at end,
      lease_expires_at = null,
      handoff_note = case when owner = p_agent and status = 'in_progress'
                          then left(trim(handoff_note || E'\n' || format('(Released: %s was removed from the team mid-task. Continue from the note above.)', name)), 4000)
                          else handoff_note end,
      updated_at = now()
    where id = t.id
    returning * into t;
    r := null;
    if t.status in ('ready', 'blocked') and coalesce((board._manager_cfg() ->> 'auto_route')::boolean, true) then
      r := board._route(t.id, 'fernando', p_via, p_agent);
    end if;
    moved := moved || jsonb_build_object('task', 'T-' || t.id, 'title', t.title, 'to', r ->> 'to');
  end loop;

  if jsonb_array_length(moved) > 0 then
    perform board._log('fernando', p_via, p_project, null, 'handover', jsonb_build_object('agent', p_agent, 'moved', moved));
    perform board._system_msg(p_project, null, 'fernando', format('%s left the team; its open work moved: %s.', name,
      (select string_agg(format('%s → %s', x ->> 'task', coalesce(x ->> 'to', 'unassigned')), ', ') from jsonb_array_elements(moved) x)));
  end if;
  return moved;
end $$;

-- ---------- the weekly consistency check ----------

create or replace function board.consistency_check() returns jsonb
language plpgsql set search_path = '' as $$
declare
  p     record;
  made  int := 0;
begin
  for p in select * from board.projects where status = 'active' and supervisor is not null loop
    continue when exists (select 1 from board.tasks where project_id = p.id and title = 'Weekly consistency check' and status <> 'done');
    perform board._create_task('manager', 'floor manager', jsonb_build_object(
      'project', p.slug, 'title', 'Weekly consistency check', 'assignee', p.supervisor, 'priority', 3,
      'description', 'Compare this project''s current Memory with the files and messages from the past week. '
        || 'For every pair of sources that disagree, call flag_conflict (about, source_a, source_b, with where each one is). '
        || 'Do not decide conflicts in this task. Evidence: the list of conflicts flagged, or "none found" with what you checked.'), true);
    made := made + 1;
  end loop;
  if made > 0 then
    perform board._log('manager', 'floor manager', null, null, 'consistency_check', jsonb_build_object('tasks', made));
  end if;
  return jsonb_build_object('tasks_created', made);
end $$;

-- ---------- entry points: one more thin layer over the previous ones ----------

alter function public.board_agent(text, text, jsonb, text) set schema board;
alter function board.board_agent(text, text, jsonb, text) rename to _agent_mgr;
alter function public.board_owner(text, text, jsonb, text) set schema board;
alter function board.board_owner(text, text, jsonb, text) rename to _owner_mgr;
revoke execute on function board._agent_mgr(text, text, jsonb, text) from public, anon, authenticated;
revoke execute on function board._owner_mgr(text, text, jsonb, text) from public, anon, authenticated;

create function public.board_agent(p_key text, p_action text, p_args jsonb default '{}', p_via text default 'api')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  act text := lower(coalesce(p_action, ''));
  p   jsonb := coalesce(p_args, '{}'::jsonb);
  via text := left(coalesce(p_via, 'api'), 200);
  a   board.agents;
  r   jsonb;
  oc  jsonb;
begin
  case act
  when 'flag_conflict' then
    a := board._agent(p_key);
    return board._flag_conflict(a, via, p);
  when 'resolve_conflict' then
    a := board._agent(p_key);
    return board._resolve_conflict(a.id, via, p, false);
  when 'briefing' then
    r := board._agent_mgr(p_key, p_action, p, via);
    a := board._agent(p_key);
    oc := board._open_conflicts(a.id);
    if exists (select 1 from jsonb_array_elements(oc) c where c ->> 'decide' = 'supervisor' and c ->> 'raised_by' <> a.id) then
      r := jsonb_set(r, '{your_move}', to_jsonb('FIRST: you have conflicts to decide as Supervisor (see conflicts): call resolve_conflict for each. '
                                              || coalesce(r ->> 'your_move', '')));
    end if;
    return r || jsonb_build_object('conflicts', oc);
  else
    return board._agent_mgr(p_key, p_action, p, via);
  end case;
end $$;

create function public.board_owner(p_token text, p_action text, p_args jsonb default '{}', p_via text default 'dashboard')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  act text := lower(coalesce(p_action, ''));
  p   jsonb := coalesce(p_args, '{}'::jsonb);
  via text := left(coalesce(p_via, 'dashboard'), 200);
  r   jsonb;
  k   text;
begin
  case act
  when 'snapshot' then
    r := board._owner_mgr(p_token, p_action, p, via);
    return r || jsonb_build_object(
      'conflicts', (select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('project', pr.slug) order by c.id desc), '[]') from (
                      select * from board.conflicts where status = 'open' or resolved_at > now() - interval '14 days'
                      order by id desc limit 40) c left join board.projects pr on pr.id = c.project_id),
      'avatars', (select coalesce(jsonb_object_agg(agent_id, image), '{}') from board.avatars));
  when 'resolve_conflict' then
    perform board._owner(p_token);
    return board._resolve_conflict('fernando', via, p, true);
  when 'save_avatar' then
    perform board._owner(p_token);
    k := lower(trim(p ->> 'agent'));
    if not exists (select 1 from board.agents where id = k) then
      raise exception 'Agent "%" not found.', k using errcode = 'PT404';
    end if;
    if nullif(p ->> 'image', '') is null then
      delete from board.avatars where agent_id = k;
    else
      insert into board.avatars (agent_id, image, updated_at) values (k, p ->> 'image', now())
      on conflict (agent_id) do update set image = excluded.image, updated_at = now();
    end if;
    perform board._log('fernando', via, null, null, 'sprite_changed', jsonb_build_object('agent', k, 'custom', nullif(p ->> 'image', '') is not null));
    return jsonb_build_object('agent', k, 'custom', nullif(p ->> 'image', '') is not null);
  when 'save_assignment' then
    r := board._owner_mgr(p_token, p_action, p, via);
    if coalesce((p ->> 'remove')::boolean, false) then
      r := r || jsonb_build_object('handed_over', board._handover(board._project_id(p ->> 'project'), lower(trim(p ->> 'agent')), via));
    end if;
    return r;
  when 'run_consistency_check' then
    perform board._owner(p_token);
    return board.consistency_check();
  else
    return board._owner_mgr(p_token, p_action, p, via);
  end case;
end $$;

revoke execute on function public.board_agent(text, text, jsonb, text) from public;
revoke execute on function public.board_owner(text, text, jsonb, text) from public;
grant  execute on function public.board_agent(text, text, jsonb, text) to anon, authenticated;
grant  execute on function public.board_owner(text, text, jsonb, text) to anon, authenticated;
