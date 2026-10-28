-- Routines: work that repeats. A routine belongs to a project and makes a fresh Ready task on its
-- schedule ("once a day", "every 4 hours", "once a week"), for one agent or for whoever the Floor
-- picks, until Fernando or the Supervisor pauses or ends it. If yesterday's copy is still open, no new
-- copy is made, so work never piles up. Fernando and project Supervisors switch routines on directly;
-- other team members propose them, and the proposal waits for Fernando or the Supervisor.

create table board.routines (
  id            bigserial primary key,
  project_id    bigint not null references board.projects (id),
  title         text not null check (length(title) between 1 and 200),
  description   text not null default '',
  assignee      text references board.agents (id),
  role_tag      text not null default 'any',
  priority      int not null default 2 check (priority between 1 and 3),
  skills        text[] not null default '{}',
  every_minutes int not null check (every_minutes between 60 and 40320),
  next_at       timestamptz not null,
  status        text not null default 'active' check (status in ('proposed', 'active', 'paused', 'ended')),
  until_note    text not null default '',
  last_task_id  bigint references board.tasks (id),
  runs          int not null default 0,
  created_by    text not null,
  decided_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table board.routines enable row level security;
create index routines_due on board.routines (next_at) where status = 'active';

alter table board.tasks add column routine_id bigint references board.routines (id);

create or replace function board._routine_view(r board.routines) returns jsonb language sql stable set search_path = '' as $$
  select to_jsonb(r) || jsonb_build_object(
    'project', (select slug from board.projects where id = r.project_id),
    'every', board._cadence_label(r.every_minutes),
    'last_task', (select jsonb_build_object('ref', 'T-' || t.id, 'status', t.status, 'owner', t.owner)
                  from board.tasks t where t.id = r.last_task_id))
$$;

-- Make the copies that are due. p_only limits it to one routine (used right after one is switched on).
create or replace function board.run_routines(p_only bigint default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  r     board.routines;
  proj  board.projects;
  t     jsonb;
  tid   bigint;
  made  int := 0;
  held  int := 0;
begin
  for r in select * from board.routines
           where status = 'active' and next_at <= now() and (p_only is null or id = p_only)
           order by next_at for update skip locked loop
    select * into proj from board.projects where id = r.project_id;
    continue when proj.status <> 'active';
    if r.last_task_id is not null and exists (select 1 from board.tasks where id = r.last_task_id and status <> 'done') then
      held := held + 1;
    else
      t := board._create_task('manager', 'routine #' || r.id, jsonb_build_object(
        'project', proj.slug,
        'title', left(r.title || ' · ' || to_char(now() at time zone 'America/Chicago', 'Mon FMDD'), 200),
        'description', r.description || E'\n\n' || format('Routine #%s: repeats %s%s. Finish this copy; a fresh one appears on schedule.',
          r.id, board._cadence_label(r.every_minutes), case when r.until_note <> '' then ' until ' || r.until_note else '' end),
        'role_tag', r.role_tag, 'priority', r.priority, 'assignee', r.assignee), true);
      tid := (t ->> 'id')::bigint;
      update board.tasks set routine_id = r.id, skills = r.skills where id = tid;
      if r.assignee is null then perform board._route_if_open(tid, 'manager', 'routine #' || r.id); end if;
      update board.routines set last_task_id = tid, runs = runs + 1 where id = r.id;
      made := made + 1;
    end if;
    -- Next due time stays on the routine's own clock (same time of day for daily ones).
    update board.routines set
      next_at = next_at + make_interval(mins => every_minutes * (floor(extract(epoch from now() - next_at) / 60 / every_minutes)::int + 1)),
      updated_at = now()
    where id = r.id;
  end loop;
  return jsonb_build_object('tasks_created', made, 'still_open', held);
end $$;

-- Create or change a routine. Fernando and the project Supervisor switch routines on; other team
-- members' new routines start as proposals. Whoever proposed one can still edit, pause or end it.
create or replace function board._save_routine(p_actor text, p_via text, p jsonb, p_is_owner boolean) returns jsonb
language plpgsql set search_path = '' as $$
declare
  rid    bigint := nullif(regexp_replace(coalesce(p ->> 'id', ''), '\D', '', 'g'), '')::bigint;
  r      board.routines;
  pid    bigint;
  is_sup boolean;
  mins   int;
  st     text;
  sup    text;
begin
  if rid is not null then
    select * into r from board.routines where id = rid for update;
    if not found then
      raise exception 'Routine #% not found.', rid using errcode = 'PT404';
    end if;
    pid := r.project_id;
  else
    pid := board._project_id(p ->> 'project');
  end if;
  is_sup := not p_is_owner and board._is_sup(p_actor, pid);
  if not p_is_owner and not is_sup and not exists (select 1 from board.assignments where project_id = pid and agent_id = p_actor) then
    raise exception 'You are not on that project.' using errcode = 'PT403';
  end if;
  if rid is null or p ? 'every' then
    mins := board._cadence_minutes(p ->> 'every');
    if mins is null or mins < 60 or mins > 40320 then
      raise exception 'Say how often, from "every hour" to "every 4 weeks". Example: {"every": "once a day"}.' using errcode = 'PT400';
    end if;
  end if;
  perform board._check_secrets(coalesce(p ->> 'title', '') || ' ' || coalesce(p ->> 'description', '') || ' ' || coalesce(p ->> 'until', ''));

  if rid is null then
    if trim(coalesce(p ->> 'title', '')) = '' then
      raise exception 'A routine needs a title.' using errcode = 'PT400';
    end if;
    st := case when p_is_owner or is_sup then 'active' else 'proposed' end;
    insert into board.routines (project_id, title, description, assignee, role_tag, priority, skills, every_minutes,
                                next_at, status, until_note, created_by, decided_by)
    values (pid, trim(p ->> 'title'), coalesce(p ->> 'description', ''), board._valid_agent(p ->> 'assignee'),
            coalesce(nullif(lower(trim(p ->> 'role_tag')), ''), 'any'), coalesce(nullif(p ->> 'priority', '')::int, 2),
            case when p ? 'skills' then board._clean_skills(p -> 'skills') else '{}' end, mins,
            coalesce(nullif(p ->> 'start', '')::timestamptz, now()), st, left(trim(coalesce(p ->> 'until', '')), 200),
            p_actor, case when st = 'active' then p_actor end)
    returning * into r;
    perform board._log(p_actor, p_via, pid, null, 'routine_created',
      jsonb_build_object('routine_id', r.id, 'title', r.title, 'every', board._cadence_label(mins), 'status', st));
    if st = 'proposed' then
      perform board._system_msg(pid, null, 'fernando', format('%s proposes a routine: "%s", %s%s. Approve or decline it on Home.',
        p_actor, r.title, board._cadence_label(mins), case when r.assignee is not null then ' for ' || r.assignee else '' end));
      select supervisor into sup from board.projects where id = pid;
      if sup is not null and sup <> p_actor then
        perform board._system_msg(pid, null, sup, format('%s proposes routine #%s "%s" (%s). As Supervisor you can switch it on: save_routine {"id": %s, "status": "active"}, or decline it with "ended".',
          p_actor, r.id, r.title, board._cadence_label(mins), r.id));
      end if;
    end if;
  else
    if not (p_is_owner or is_sup or r.created_by = p_actor) then
      raise exception 'Only Fernando, the Supervisor or whoever proposed routine #% can change it. Post a message instead.', r.id using errcode = 'PT403';
    end if;
    st := lower(coalesce(nullif(p ->> 'status', ''), r.status));
    if st not in ('proposed', 'active', 'paused', 'ended') then
      raise exception 'Status must be active, paused or ended.' using errcode = 'PT400';
    end if;
    if st = 'active' and r.status <> 'active' and not (p_is_owner or is_sup) then
      raise exception 'Only Fernando or the Supervisor can switch a routine on.' using errcode = 'PT403';
    end if;
    if (p ? 'assignee' or p ? 'priority') and not (p_is_owner or is_sup) and r.status <> 'proposed' then
      raise exception 'Only Fernando or the Supervisor can change who does routine #% or its priority.', r.id using errcode = 'PT403';
    end if;
    update board.routines set
      title = coalesce(nullif(trim(p ->> 'title'), ''), title),
      description = coalesce(p ->> 'description', description),
      assignee = case when p ? 'assignee' then board._valid_agent(p ->> 'assignee') else assignee end,
      role_tag = coalesce(nullif(lower(trim(p ->> 'role_tag')), ''), role_tag),
      priority = coalesce(nullif(p ->> 'priority', '')::int, priority),
      skills = case when p ? 'skills' then board._clean_skills(p -> 'skills') else skills end,
      every_minutes = coalesce(mins, every_minutes),
      next_at = coalesce(nullif(p ->> 'start', '')::timestamptz, case when st = 'active' and status <> 'active' then greatest(next_at, now()) end, next_at),
      until_note = case when p ? 'until' then left(trim(p ->> 'until'), 200) else until_note end,
      status = st,
      decided_by = case when st = 'active' and status = 'proposed' then p_actor else decided_by end,
      updated_at = now()
    where id = r.id returning * into r;
    perform board._log(p_actor, p_via, pid, null, 'routine_saved',
      jsonb_build_object('routine_id', r.id, 'status', r.status, 'fields', (select coalesce(jsonb_agg(x), '[]') from jsonb_object_keys(p) x where x <> 'id')));
    if r.created_by not in (p_actor, 'fernando') and r.status in ('active', 'ended') and p ? 'status' then
      perform board._system_msg(pid, null, r.created_by, format('%s %s your routine #%s "%s".', p_actor,
        case r.status when 'active' then 'switched on' else 'ended' end, r.id, r.title));
    end if;
  end if;
  if r.status = 'active' then
    perform board.run_routines(r.id);
    select * into r from board.routines where id = r.id;
  end if;
  return board._routine_view(r);
end $$;

-- Routines on the projects an agent works on (or supervises).
create or replace function board._routines_for(p_agent text) returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(board._routine_view(r) order by r.id), '[]') from board.routines r
  where r.status in ('proposed', 'active', 'paused')
    and (exists (select 1 from board.assignments s where s.project_id = r.project_id and s.agent_id = p_agent)
         or board._is_sup(p_agent, r.project_id))
$$;

select cron.schedule('board-routines', '6-59/10 * * * *', $$select board.run_routines()$$);

-- ---------- entry points: one more thin layer over the previous ones ----------

alter function public.board_agent(text, text, jsonb, text) set schema board;
alter function board.board_agent(text, text, jsonb, text) rename to _agent_cfl;
alter function public.board_owner(text, text, jsonb, text) set schema board;
alter function board.board_owner(text, text, jsonb, text) rename to _owner_cfl;
revoke execute on function board._agent_cfl(text, text, jsonb, text) from public, anon, authenticated;
revoke execute on function board._owner_cfl(text, text, jsonb, text) from public, anon, authenticated;

create function public.board_agent(p_key text, p_action text, p_args jsonb default '{}', p_via text default 'api')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  act text := lower(coalesce(p_action, ''));
  p   jsonb := coalesce(p_args, '{}'::jsonb);
  via text := left(coalesce(p_via, 'api'), 200);
  a   board.agents;
  r   jsonb;
begin
  case act
  when 'save_routine', 'create_routine', 'update_routine' then
    a := board._agent(p_key);
    return board._save_routine(a.id, via, p, false);
  when 'list_routines' then
    a := board._agent(p_key);
    return jsonb_build_object('routines', board._routines_for(a.id));
  when 'briefing' then
    r := board._agent_cfl(p_key, p_action, p, via);
    a := board._agent(p_key);
    return r || jsonb_build_object('routines', board._routines_for(a.id));
  else
    return board._agent_cfl(p_key, p_action, p, via);
  end case;
end $$;

create function public.board_owner(p_token text, p_action text, p_args jsonb default '{}', p_via text default 'dashboard')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  act text := lower(coalesce(p_action, ''));
  p   jsonb := coalesce(p_args, '{}'::jsonb);
  via text := left(coalesce(p_via, 'dashboard'), 200);
  r   jsonb;
begin
  case act
  when 'snapshot' then
    r := board._owner_cfl(p_token, p_action, p, via);
    return r || jsonb_build_object('routines', (select coalesce(jsonb_agg(board._routine_view(x) order by x.id), '[]')
      from board.routines x where x.status <> 'ended' or x.updated_at > now() - interval '14 days'));
  when 'save_routine' then
    perform board._owner(p_token);
    return board._save_routine('fernando', via, p, true);
  when 'run_routines' then
    perform board._owner(p_token);
    return board.run_routines();
  else
    return board._owner_cfl(p_token, p_action, p, via);
  end case;
end $$;

revoke execute on function public.board_agent(text, text, jsonb, text) from public;
revoke execute on function public.board_owner(text, text, jsonb, text) from public;
grant  execute on function public.board_agent(text, text, jsonb, text) to anon, authenticated;
grant  execute on function public.board_owner(text, text, jsonb, text) to anon, authenticated;
