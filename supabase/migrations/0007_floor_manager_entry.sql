-- Floor Manager, part C: the entry points. The existing board_agent / board_owner move into the private
-- schema as _agent_core / _owner_core; new public wrappers add the manager's actions and delegate the rest.

alter function public.board_agent(text, text, jsonb, text) set schema board;
alter function board.board_agent(text, text, jsonb, text) rename to _agent_core;
alter function public.board_owner(text, text, jsonb, text) set schema board;
alter function board.board_owner(text, text, jsonb, text) rename to _owner_core;
revoke execute on function board._agent_core(text, text, jsonb, text) from public, anon, authenticated;
revoke execute on function board._owner_core(text, text, jsonb, text) from public, anon, authenticated;

-- Route a freshly created Ready task if nobody is lined up for it.
create or replace function board._route_if_open(p_task bigint, p_actor text, p_via text) returns jsonb
language plpgsql set search_path = '' as $$
declare t board.tasks;
begin
  select * into t from board.tasks where id = p_task;
  if found and t.status = 'ready' and t.assignee is null and t.human_gate is null
     and coalesce((board._manager_cfg() ->> 'auto_route')::boolean, true)
     and (t.role_tag = 'any' or not board._has_worker(t)) then
    return board._route(t.id, p_actor, p_via);
  end if;
  return null;
end $$;

create function public.board_agent(p_key text, p_action text, p_args jsonb default '{}', p_via text default 'api')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  act   text := lower(coalesce(p_action, ''));
  p     jsonb := coalesce(p_args, '{}'::jsonb);
  via   text := left(coalesce(p_via, 'api'), 200);
  a     board.agents;
  r     jsonb;
  rt    jsonb;
  rq    board.schedule_requests;
  first text := '';
begin
  case act
  when 'request_schedule' then
    a := board._agent(p_key);
    return board._request_schedule(a.id, 'agent', via, p);
  when 'confirm_schedule' then
    a := board._agent(p_key);
    return board._schedule_done(a.id, via, a.id, p);
  when 'update_profile' then
    a := board._agent(p_key);
    return board._update_profile(a, via, p);
  when 'create_task' then
    r := board._agent_core(p_key, p_action, p, via);
    a := board._agent(p_key);
    if p ? 'skills' then
      update board.tasks set skills = board._clean_skills(p -> 'skills') where id = (r ->> 'id')::bigint;
    end if;
    rt := board._route_if_open((r ->> 'id')::bigint, a.id, via);
    return case when rt is null then r else (rt -> 'task') || jsonb_build_object('notice', r ->> 'notice', 'routed', rt) end;
  when 'briefing' then
    perform board._expire_schedules();
    r := board._agent_core(p_key, p_action, p, via);
    a := board._agent(p_key);
    select * into rq from board.schedule_requests
    where agent_id = a.id and status in ('approved', 'expired') order by id desc limit 1;
    if found and a.wake_trigger_id is null then
      first := case rq.status
        when 'approved' then format('FIRST: Fernando approved your schedule change (#%s): run %s%s. Change your own scheduled task in your app to match (you can do this yourself), then call confirm_schedule. ',
                                    rq.id, rq.every, coalesce(' until ' || to_char(rq.until at time zone 'utc', 'YYYY-MM-DD HH24:MI "UTC"'), ''))
        else format('FIRST: your temporary schedule (#%s) has ended. Set your own scheduled task back to "%s", then call confirm_schedule. ', rq.id, rq.prev_every)
      end;
    end if;
    if cardinality(a.skills) = 0 or a.profile = '' then
      first := first || 'Your skill profile is empty: call update_profile with your real skills and limits so the Floor Manager routes the right work to you. ';
    end if;
    if first <> '' then
      r := jsonb_set(r, '{your_move}', to_jsonb(first || coalesce(r ->> 'your_move', '')));
    end if;
    return r || jsonb_build_object(
      'profile', jsonb_build_object('skills', to_jsonb(a.skills), 'profile', a.profile, 'skills_vocab', to_jsonb(board._skills_vocab())),
      'schedule', jsonb_build_object('clock_in_every', a.clock_in_every,
        'requests', (select coalesce(jsonb_agg(to_jsonb(s) order by s.id desc), '[]') from (
                      select * from board.schedule_requests where agent_id = a.id order by id desc limit 3) s)));
  else
    return board._agent_core(p_key, p_action, p, via);
  end case;
end $$;

create function public.board_owner(p_token text, p_action text, p_args jsonb default '{}', p_via text default 'dashboard')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  act text := lower(coalesce(p_action, ''));
  p   jsonb := coalesce(p_args, '{}'::jsonb);
  via text := left(coalesce(p_via, 'dashboard'), 200);
  r   jsonb;
  rt  jsonb;
  k   text;
begin
  case act
  when 'snapshot' then
    perform board._owner(p_token);
    perform board._expire_schedules();
    r := board._owner_core(p_token, p_action, p, via);
    return r || jsonb_build_object(
      'schedule_requests', (select coalesce(jsonb_agg(to_jsonb(s) order by s.id desc), '[]') from (
                             select * from board.schedule_requests
                             where status in ('pending', 'approved', 'expired') or created_at > now() - interval '14 days'
                             order by id desc limit 40) s),
      'manager', jsonb_build_object('settings', board._manager_cfg(), 'skills_vocab', to_jsonb(board._skills_vocab())));
  when 'decide_schedule' then
    perform board._owner(p_token);
    return board._decide_schedule(via, p);
  when 'schedule_applied' then
    perform board._owner(p_token);
    return board._schedule_done('fernando', via, null, p);
  when 'route_task' then
    perform board._owner(p_token);
    return board._route(board._task_id(p), 'fernando', via, nullif(p ->> 'exclude', ''));
  when 'run_manager' then
    perform board._owner(p_token);
    return board.manage('fernando');
  when 'save_manager' then
    perform board._owner(p_token);
    insert into board.settings (key, value, updated_at)
    values ('manager', jsonb_build_object(
              'auto_route', coalesce((p ->> 'auto_route')::boolean, true),
              'auto_effort', coalesce((p ->> 'auto_effort')::boolean, true))::text, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
    perform board._log('fernando', via, null, null, 'manager_settings', p);
    return board._manager_cfg();
  when 'create_task' then
    r := board._owner_core(p_token, p_action, p, via);
    if p ? 'skills' then
      update board.tasks set skills = board._clean_skills(p -> 'skills') where id = (r ->> 'id')::bigint;
    end if;
    rt := board._route_if_open((r ->> 'id')::bigint, 'fernando', via);
    return case when rt is null then r else (rt -> 'task') || jsonb_build_object('routed', rt) end;
  when 'update_task' then
    r := board._owner_core(p_token, p_action, p, via);
    if p ? 'skills' then
      update board.tasks set skills = board._clean_skills(p -> 'skills') where id = board._task_id(p);
    end if;
    return r;
  when 'save_agent' then
    r := board._owner_core(p_token, p_action, p, via);
    k := lower(trim(p ->> 'id'));
    if p ? 'skills' or p ? 'profile' then
      perform board._check_secrets(coalesce(p ->> 'profile', ''));
      update board.agents set
        skills = case when p ? 'skills' then board._clean_skills(p -> 'skills') else skills end,
        profile = case when p ? 'profile' then left(trim(p ->> 'profile'), 1500) else profile end,
        profile_updated_at = now()
      where id = k;
      r := (select board._agent_view(a) from board.agents a where a.id = k);
    end if;
    return r;
  else
    return board._owner_core(p_token, p_action, p, via);
  end case;
end $$;

revoke execute on function public.board_agent(text, text, jsonb, text) from public;
revoke execute on function public.board_owner(text, text, jsonb, text) from public;
grant  execute on function public.board_agent(text, text, jsonb, text) to anon, authenticated;
grant  execute on function public.board_owner(text, text, jsonb, text) to anon, authenticated;
