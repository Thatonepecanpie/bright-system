-- Floor Manager, part B: routing, self-correction, effort balancing and schedule requests.
-- Everything runs inside Postgres: no LLM calls, so it costs nothing. The manager runs every 10 minutes
-- (pg_cron, see 0008), right after a task is created, and on demand from the dashboard.

-- ---------- vocabulary ----------

create or replace function board._skills_vocab() returns text[] language sql immutable set search_path = '' as $$
  select array['research', 'writing', 'coding', 'data', 'design', 'web', 'planning', 'review', 'outreach', 'admin']
$$;

-- Accepts a JSON array or a comma-separated string; keeps known skills only.
create or replace function board._clean_skills(p jsonb) returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct s order by s), '{}') from (
    select lower(trim(x)) s
    from jsonb_array_elements_text(case jsonb_typeof(p)
                                     when 'array' then p
                                     when 'string' then to_jsonb(string_to_array(p #>> '{}', ','))
                                     else '[]'::jsonb end) x) y
  where s = any (board._skills_vocab())
$$;

-- Guess the skills a task needs from its words, when nobody said.
create or replace function board._infer_skills(p_text text) returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(k order by k), '{}') from (values
    ('research', '\m(research|find|compare|investigat|look up|survey|source|supplier|competitor|market|options)'),
    ('writing',  '\m(write|draft|copy|blog|article|email|post|summar|rewrite|edit|proposal|letter|caption|screenplay)'),
    ('coding',   '\m(code|coding|script|bug|api|deploy|function|sql|database|program|automat|integrat|website build)'),
    ('data',     '\m(spreadsheet|data|csv|excel|sheet|analy|metric|report|numbers|budget|forecast)'),
    ('design',   '\m(design|logo|mockup|ui|ux|image|graphic|brand|layout|slide|visual)'),
    ('web',      '\m(browse|website|web|online|scrape|search|url|link|google)'),
    ('planning', '\m(plan|strategy|roadmap|schedule|organi[sz]|prioriti|break down|outline|steps)'),
    ('review',   '\m(review|qa|check|verify|proofread|test|audit|feedback)'),
    ('outreach', '\m(outreach|contact|reach out|lead|prospect|social|marketing|campaign|newsletter)'),
    ('admin',    '\m(admin|form|invoice|calendar|booking|paperwork|organize files)')
  ) v(k, rx) where lower(coalesce(p_text, '')) ~ rx
$$;

-- "every 4 hours" -> 240; "once a day" -> 1440; "on demand" -> null.
create or replace function board._cadence_minutes(p text) returns int language plpgsql immutable set search_path = '' as $$
declare
  t text := lower(coalesce(p, ''));
  n numeric := coalesce(substring(t from '(\d+(?:\.\d+)?)')::numeric, 1);
begin
  if t ~ '(demand|manual|never|off)' then return null; end if;
  if t ~ 'min' then return round(n); end if;
  if t ~ '(hour|hr)' then return round(n * 60); end if;
  if t ~ '(day|daily)' then return round(n * 1440); end if;
  if t ~ 'week' then return round(n * 10080); end if;
  return null;
end $$;

create or replace function board._cadence_label(p_minutes int) returns text language sql immutable set search_path = '' as $$
  select case
    when p_minutes is null then 'on demand'
    when p_minutes % 10080 = 0 then case when p_minutes = 10080 then 'once a week' else 'every ' || p_minutes / 10080 || ' weeks' end
    when p_minutes % 1440 = 0 then case when p_minutes = 1440 then 'once a day' else 'every ' || p_minutes / 1440 || ' days' end
    when p_minutes % 60 = 0 then case when p_minutes = 60 then 'every hour' else 'every ' || p_minutes / 60 || ' hours' end
    else 'every ' || p_minutes || ' minutes' end
$$;

-- Validate and normalise a requested schedule.
create or replace function board._norm_every(p text) returns text language plpgsql immutable set search_path = '' as $$
declare m int := board._cadence_minutes(p);
begin
  if lower(coalesce(p, '')) ~ '(demand|manual)' then return 'on demand'; end if;
  if m is null or m < 15 or m > 20160 then
    raise exception 'Say how often, from "every 15 minutes" to "every 2 weeks", or "on demand". Example: {"every": "every 2 hours"}.'
      using errcode = 'PT400';
  end if;
  return board._cadence_label(m);
end $$;

create or replace function board._manager_cfg() returns jsonb language sql stable set search_path = '' as $$
  select coalesce((select value::jsonb from board.settings where key = 'manager'), '{}'::jsonb)
$$;

-- ---------- routing ----------

-- How well an agent fits a task right now, with the reasons in plain words.
create or replace function board._route_score(a board.agents, t board.tasks) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  need   text[] := case when cardinality(t.skills) > 0 then t.skills else board._infer_skills(t.title || ' ' || t.description) end;
  hit    text[] := array(select s from unnest(need) s where s = any (a.skills));
  mins   int := board._cadence_minutes(a.clock_in_every);
  load   int;
  turns  int;
  tokens bigint;
  passes int;
  backs  int;
  score  numeric := 0;
  why    text[] := '{}';
begin
  if cardinality(need) > 0 then
    score := score + cardinality(hit) * 3 - (cardinality(need) - cardinality(hit));
    why := why || case when cardinality(hit) > 0 then 'skills: ' || array_to_string(hit, ', ') else 'no matching skills' end;
  end if;

  if exists (select 1 from board.assignments s where s.project_id = t.project_id and s.agent_id = a.id)
     or board._is_sup(a.id, t.project_id) then
    score := score + 1;
    if exists (select 1 from board.assignments s where s.project_id = t.project_id and s.agent_id = a.id and s.role = t.role_tag) then
      score := score + 2;
      why := why || ('role ' || t.role_tag);
    else
      why := why || 'on the team';
    end if;
  end if;

  select count(*) into load from board.tasks x
  where (x.assignee = a.id and x.status in ('ready', 'blocked')) or (x.owner = a.id and x.status = 'in_progress');
  score := score - load * 1.5;
  why := why || case when load = 0 then 'free now' else load || ' task(s) queued' end;

  if a.last_seen_at is null then
    score := score - 8;
    why := why || 'never connected';
  elsif mins is not null and a.last_seen_at < now() - make_interval(mins => (mins * 1.5)::int) then
    score := score - 4;
    why := why || 'overdue';
  elsif mins is not null then
    score := score + greatest(0, 2 - mins / 360.0);   -- runs often, so it starts sooner
    why := why || ('runs ' || a.clock_in_every);
  else
    score := score - 1;
    why := why || 'runs on demand';
  end if;

  if a.turn_limit is not null then
    select count(*) into turns from board.events e
    where e.actor = a.id and e.action = 'clock_in' and e.at > now() - make_interval(hours => a.usage_window_hours);
    if turns >= a.turn_limit then
      score := score - 5;
      why := why || 'out of turns this window';
    else
      score := score + (1 - turns::numeric / a.turn_limit) * 1.5;
    end if;
  end if;
  if a.token_budget is not null then
    select coalesce(sum((e.detail ->> 'tokens_used')::bigint), 0) into tokens from board.events e
    where e.actor = a.id and e.action = 'clock_out' and e.detail ? 'tokens_used';
    if tokens >= a.token_budget then
      score := score - 10;
      why := why || 'token budget used up';
    end if;
  end if;

  -- Track record: work that passed review vs. work sent back, last 60 days.
  select count(*) into passes from board.tasks x
  where x.owner = a.id and x.status = 'done' and x.status_changed_at > now() - interval '60 days';
  select count(*) into backs from board.events e
  where e.action = 'status_changed' and e.detail ->> 'from' = 'review' and e.detail ->> 'to' in ('ready', 'in_progress', 'blocked')
    and e.at > now() - interval '60 days'
    and (select c.actor from board.events c where c.task_id = e.task_id and c.action = 'claimed' and c.at < e.at
         order by c.at desc limit 1) = a.id;
  if passes + backs > 0 then
    score := score + (passes::numeric / (passes + backs) - 0.5) * 3;
    why := why || (passes || ' passed / ' || backs || ' sent back');
  end if;

  return jsonb_build_object('agent', a.id, 'score', round(score, 2), 'why', to_jsonb(why));
end $$;

-- Give a task to the best-fitting agent (optionally not the one it is leaving), and say why.
create or replace function board._route(p_task bigint, p_actor text, p_via text, p_exclude text default null)
returns jsonb language plpgsql set search_path = '' as $$
declare
  t    board.tasks;
  best jsonb;
  prev text;
  why  text;
begin
  select * into t from board.tasks where id = p_task for update;
  if not found then
    raise exception 'Task T-% not found.', p_task using errcode = 'PT404';
  end if;
  if t.status not in ('ready', 'backlog', 'blocked') then
    raise exception 'T-% is % and cannot be rerouted now.', t.id, t.status using errcode = 'PT409';
  end if;

  select s into best from (
    select board._route_score(a, t) s from board.agents a
    where a.status = 'active' and a.retired_at is null and a.id is distinct from p_exclude) x
  order by (s ->> 'score')::numeric desc, s ->> 'agent'
  limit 1;
  if best is null then
    return jsonb_build_object('routed', false, 'message', 'No active agent to route to.');
  end if;

  prev := t.assignee;
  why := (select string_agg(x, ', ') from jsonb_array_elements_text(best -> 'why') x);
  update board.tasks set
    assignee = best ->> 'agent',
    skills = case when cardinality(skills) = 0 then board._infer_skills(title || ' ' || description) else skills end,
    route_reason = left(format('Floor Manager picked %s: %s.', best ->> 'agent', why), 500),
    routed_at = now(), route_count = route_count + 1, updated_at = now()
  where id = t.id
  returning * into t;

  perform board._log(p_actor, p_via, t.project_id, t.id, 'routed',
    jsonb_build_object('to', t.assignee, 'from', prev, 'score', best -> 'score', 'why', best -> 'why'));
  if prev is distinct from t.assignee then
    perform board._system_msg(t.project_id, t.id, t.assignee,
      format('Floor Manager: T-%s "%s" is assigned to you (%s). Claim it on your next turn.', t.id, t.title, why));
  end if;
  return jsonb_build_object('routed', true, 'to', t.assignee, 'from', prev, 'score', best -> 'score', 'why', best -> 'why',
                            'task', board._tj(t));
end $$;

-- ---------- schedule requests ----------

create or replace function board._request_schedule(p_agent text, p_source text, p_via text, p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  a   board.agents;
  ev  text := board._norm_every(p ->> 'every');
  why text := trim(coalesce(p ->> 'reason', ''));
  til timestamptz;
  tid bigint := nullif(regexp_replace(coalesce(p ->> 'task_id', ''), '\D', '', 'g'), '')::bigint;
  rq  board.schedule_requests;
begin
  select * into a from board.agents where id = p_agent;
  if not found then
    raise exception 'Agent not found.' using errcode = 'PT404';
  end if;
  if length(why) < 5 then
    raise exception 'Give a reason: which task needs it and why.' using errcode = 'PT400';
  end if;
  perform board._check_secrets(why);
  if nullif(trim(p ->> 'until'), '') is not null then
    if p ->> 'until' ~* '^\s*\d+\s*(hour|day|week)s?\s*$' then
      til := now() + (p ->> 'until')::interval;
    else
      begin
        til := (p ->> 'until')::timestamptz;
      exception when others then
        raise exception 'until must be a date (2026-11-01) or a length ("3 days").' using errcode = 'PT400';
      end;
    end if;
    if til <= now() or til > now() + interval '30 days' then
      raise exception 'until must be within the next 30 days.' using errcode = 'PT400';
    end if;
  end if;
  if ev = a.clock_in_every and til is null then
    raise exception 'You already run %.', ev using errcode = 'PT400';
  end if;

  update board.schedule_requests set status = 'cancelled', decided_at = now(), decision_note = 'Replaced by a newer request.'
  where agent_id = a.id and status = 'pending';
  insert into board.schedule_requests (agent_id, source, every, prev_every, reason, until, task_id)
  values (a.id, p_source, ev, a.clock_in_every, why, til, tid)
  returning * into rq;

  perform board._log(case when p_source = 'agent' then a.id else p_source end, p_via, null, tid, 'schedule_requested', to_jsonb(rq));
  perform board._system_msg(null, tid, 'fernando', format('Schedule request #%s (%s): run %s %s%s instead of %s. Reason: %s. Approve or decline on the Floor.',
    rq.id, case when p_source = 'agent' then 'from ' || a.display_name else 'Floor Manager suggests for ' || a.display_name end,
    a.display_name, ev, coalesce(' until ' || to_char(til at time zone 'utc', 'YYYY-MM-DD HH24:MI "UTC"'), ''), a.clock_in_every, why));
  return to_jsonb(rq) || jsonb_build_object('message',
    'Request sent to Fernando. Do not change your schedule until it is approved; your briefing will tell you.');
end $$;

create or replace function board._decide_schedule(p_via text, p jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare
  rq   board.schedule_requests;
  a    board.agents;
  note text := left(trim(coalesce(p ->> 'note', '')), 500);
  ev   text;
begin
  select * into rq from board.schedule_requests where id = nullif(regexp_replace(coalesce(p ->> 'id', ''), '\D', '', 'g'), '')::bigint for update;
  if not found then
    raise exception 'Schedule request not found.' using errcode = 'PT404';
  end if;
  if rq.status <> 'pending' then
    raise exception 'Request #% is already %.', rq.id, rq.status using errcode = 'PT409';
  end if;
  select * into a from board.agents where id = rq.agent_id;

  if lower(coalesce(p ->> 'decision', '')) = 'decline' then
    update board.schedule_requests set status = 'declined', decided_at = now(), decision_note = note where id = rq.id returning * into rq;
    perform board._log('fernando', p_via, null, rq.task_id, 'schedule_declined', jsonb_build_object('id', rq.id, 'note', note));
    perform board._system_msg(null, rq.task_id, rq.agent_id,
      format('Fernando declined schedule request #%s (%s).%s Keep your current schedule.', rq.id, rq.every, coalesce(' Note: ' || nullif(note, ''), '')));
    return to_jsonb(rq);
  end if;
  if lower(coalesce(p ->> 'decision', '')) <> 'approve' then
    raise exception 'decision must be "approve" or "decline".' using errcode = 'PT400';
  end if;

  ev := case when nullif(trim(p ->> 'every'), '') is not null then board._norm_every(p ->> 'every') else rq.every end;
  update board.schedule_requests set status = 'approved', every = ev, decided_at = now(), decision_note = note
  where id = rq.id returning * into rq;
  update board.agents set clock_in_every = ev where id = rq.agent_id;
  perform board._log('fernando', p_via, null, rq.task_id, 'schedule_approved', jsonb_build_object('id', rq.id, 'every', ev));
  perform board._system_msg(null, rq.task_id, rq.agent_id, case
    when a.wake_trigger_id is not null then
      format('Fernando approved schedule request #%s: you now run %s%s. The dashboard updates your scheduled task; nothing for you to do.',
             rq.id, ev, coalesce(' until ' || to_char(rq.until at time zone 'utc', 'YYYY-MM-DD HH24:MI "UTC"'), ''))
    else
      format('Fernando approved schedule request #%s: run %s%s. Change your own scheduled task in your app to match now (you can do this yourself), then call confirm_schedule.',
             rq.id, ev, coalesce(' until ' || to_char(rq.until at time zone 'utc', 'YYYY-MM-DD HH24:MI "UTC"') || ', then switch back to ' || rq.prev_every, ''))
    end);
  return to_jsonb(rq) || jsonb_build_object('wake_trigger_id', a.wake_trigger_id);
end $$;

-- The change is live in the agent's app: approved -> applied, expired -> reverted.
create or replace function board._schedule_done(p_actor text, p_via text, p_agent text, p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  rq  board.schedule_requests;
  rid bigint := nullif(regexp_replace(coalesce(p ->> 'id', p ->> 'request_id', ''), '\D', '', 'g'), '')::bigint;
begin
  select * into rq from board.schedule_requests
  where (rid is null or id = rid) and (p_agent is null or agent_id = p_agent) and status in ('approved', 'expired')
  order by id desc limit 1 for update;
  if not found then
    return jsonb_build_object('ok', false, 'message', 'No approved or ended schedule change is waiting for confirmation.');
  end if;
  if rq.status = 'approved' then
    update board.schedule_requests set status = 'applied', applied_at = now() where id = rq.id returning * into rq;
  else
    update board.schedule_requests set status = 'reverted', reverted_at = now() where id = rq.id returning * into rq;
  end if;
  perform board._log(p_actor, p_via, null, rq.task_id, 'schedule_' || rq.status,
    jsonb_build_object('id', rq.id, 'every', rq.every, 'note', left(coalesce(p ->> 'note', ''), 300)));
  return to_jsonb(rq) || jsonb_build_object('ok', true, 'message', 'Thanks, noted on the board.');
end $$;

-- Temporary schedules that ran out: the board's expectation goes back, and the agent is told to switch back.
create or replace function board._expire_schedules() returns int language plpgsql set search_path = '' as $$
declare
  rq board.schedule_requests;
  n  int := 0;
begin
  for rq in select * from board.schedule_requests
            where status in ('approved', 'applied') and until is not null and until < now() for update loop
    update board.schedule_requests set status = 'expired', expired_at = now() where id = rq.id;
    update board.agents set clock_in_every = rq.prev_every where id = rq.agent_id and rq.prev_every <> '';
    perform board._log('manager', 'floor manager', null, rq.task_id, 'schedule_expired', jsonb_build_object('id', rq.id));
    perform board._system_msg(null, rq.task_id, rq.agent_id, format(
      'Your temporary schedule (request #%s, %s) has ended. Set your own scheduled task back to "%s" in your app, then call confirm_schedule.',
      rq.id, rq.every, rq.prev_every));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- profiles ----------

-- Agents keep their own skill profile current; a Supervisor may refine its team's profiles.
create or replace function board._update_profile(a board.agents, p_via text, p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  target text := lower(coalesce(nullif(trim(p ->> 'agent'), ''), a.id));
  r      board.agents;
begin
  if target <> a.id and not exists (
    select 1 from board.projects pr join board.assignments s on s.project_id = pr.id
    where pr.supervisor = a.id and s.agent_id = target) then
    raise exception 'You can update your own profile, or the profiles of agents on a project you supervise.' using errcode = 'PT403';
  end if;
  perform board._check_secrets(coalesce(p ->> 'profile', ''));
  update board.agents set
    skills = case when p ? 'skills' then board._clean_skills(p -> 'skills') else skills end,
    profile = case when p ? 'profile' then left(trim(p ->> 'profile'), 1500) else profile end,
    profile_updated_at = now()
  where id = target
  returning * into r;
  if not found then
    raise exception 'Agent not found.' using errcode = 'PT404';
  end if;
  perform board._log(a.id, p_via, null, null, 'profile_updated', jsonb_build_object('agent', target, 'skills', r.skills));
  return jsonb_build_object('agent', r.id, 'skills', r.skills, 'profile', r.profile, 'skills_vocab', board._skills_vocab());
end $$;

-- ---------- the manager ----------

create or replace function board.manage(p_actor text default 'manager') returns jsonb
language plpgsql set search_path = '' as $$
declare
  cfg      jsonb := board._manager_cfg();
  via      text := 'floor manager';
  rec      record;
  r        jsonb;
  routed   int := 0;
  rerouted int := 0;
  proposed int := 0;
  expired  int := board._expire_schedules();
  mins     int;
  load     int;
  urgent   boolean;
begin
  if coalesce((cfg ->> 'auto_route')::boolean, true) then
    -- 1. Route Ready work nobody is lined up for: open to anyone ("any"), or a role nobody active holds.
    for rec in
      select x.id from board.tasks x join board.projects p on p.id = x.project_id
      where p.status = 'active' and x.status = 'ready' and x.assignee is null and x.human_gate is null
        and (x.role_tag = 'any' or not board._has_worker(x))
      order by x.priority, x.id limit 20
    loop
      r := board._route(rec.id, p_actor, via);
      if (r ->> 'routed')::boolean then routed := routed + 1; end if;
    end loop;

    -- 2. Self-correct: work waiting on an agent that is paused, retired, never showed up, or long overdue.
    for rec in
      select x.id, x.assignee from board.tasks x join board.agents a on a.id = x.assignee
      where x.status = 'ready' and x.route_count < 4 and (
        a.status <> 'active' or a.retired_at is not null
        or (a.last_seen_at is null and x.updated_at < now() - interval '12 hours')
        or (board._cadence_minutes(a.clock_in_every) is not null
            and a.last_seen_at < now() - make_interval(mins => board._cadence_minutes(a.clock_in_every) * 2)
            and x.updated_at < now() - make_interval(mins => board._cadence_minutes(a.clock_in_every))))
      limit 20
    loop
      r := board._route(rec.id, p_actor, via, rec.assignee);
      if (r ->> 'routed')::boolean and r ->> 'to' is distinct from rec.assignee then rerouted := rerouted + 1; end if;
    end loop;
  end if;

  if coalesce((cfg ->> 'auto_effort')::boolean, true) then
    -- 3. Effort: suggest running more often when work piles up, less often when there is nothing to do.
    for rec in
      select a.* from board.agents a
      where a.status = 'active' and a.retired_at is null and a.last_seen_at is not null
        and not exists (select 1 from board.schedule_requests s where s.agent_id = a.id and s.status in ('pending', 'approved', 'expired'))
    loop
      mins := board._cadence_minutes(rec.clock_in_every);
      continue when mins is null;
      select count(*), coalesce(bool_or(x.due_date <= current_date + 1), false) into load, urgent from board.tasks x
      where (x.assignee = rec.id and x.status in ('ready', 'blocked')) or (x.owner = rec.id and x.status = 'in_progress');

      if (load >= 3 or (urgent and mins > 120)) and mins > 60
         and not exists (select 1 from board.schedule_requests s where s.agent_id = rec.id and s.source = 'manager'
                         and s.status = 'declined' and s.decided_at > now() - interval '2 days') then
        begin
          perform board._request_schedule(rec.id, 'manager', via, jsonb_build_object(
            'every', board._cadence_label(greatest(60, mins / 2)), 'until', '3 days',
            'reason', format('%s task(s) waiting for %s%s', load, rec.display_name, case when urgent then ', one due within a day' else '' end)));
          proposed := proposed + 1;
        exception when others then null;  -- one bad suggestion must not stop the rest of the run
        end;
      elsif load = 0 and mins < 720
         and rec.created_at < now() - interval '3 days'
         and not exists (select 1 from board.events e where e.actor = rec.id and e.action = 'claimed' and e.at > now() - interval '3 days')
         and not exists (select 1 from board.tasks x where x.status = 'ready' and board._can_work(rec.id, x))
         and not exists (select 1 from board.schedule_requests s where s.agent_id = rec.id and s.source = 'manager'
                         and s.status = 'declined' and s.decided_at > now() - interval '7 days') then
        begin
          perform board._request_schedule(rec.id, 'manager', via, jsonb_build_object(
            'every', board._cadence_label(least(1440, mins * 2)),
            'reason', format('%s has had nothing to do for 3 days; running less often saves your plan''s usage', rec.display_name)));
          proposed := proposed + 1;
        exception when others then null;
        end;
      end if;
    end loop;
  end if;

  if routed + rerouted + proposed + expired > 0 then
    perform board._log(p_actor, via, null, null, 'manager_run',
      jsonb_build_object('routed', routed, 'rerouted', rerouted, 'schedule_suggestions', proposed, 'schedules_ended', expired));
  end if;
  return jsonb_build_object('routed', routed, 'rerouted', rerouted, 'schedule_suggestions', proposed, 'schedules_ended', expired);
end $$;
