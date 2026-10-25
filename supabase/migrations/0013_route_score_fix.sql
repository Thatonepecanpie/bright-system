-- Fix: bare string literals appended to the text[] 'why' were read as array literals, so routing failed
-- whenever an agent was on the team, never connected, overdue, on demand or out of turns/tokens.
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
      why := why || 'on the team'::text;
    end if;
  end if;

  select count(*) into load from board.tasks x
  where (x.assignee = a.id and x.status in ('ready', 'blocked')) or (x.owner = a.id and x.status = 'in_progress');
  score := score - load * 1.5;
  why := why || case when load = 0 then 'free now' else load || ' task(s) queued' end;

  if a.last_seen_at is null then
    score := score - 8;
    why := why || 'never connected'::text;
  elsif mins is not null and a.last_seen_at < now() - make_interval(mins => (mins * 1.5)::int) then
    score := score - 4;
    why := why || 'overdue'::text;
  elsif mins is not null then
    score := score + greatest(0, 2 - mins / 360.0);   -- runs often, so it starts sooner
    why := why || ('runs ' || a.clock_in_every);
  else
    score := score - 1;
    why := why || 'runs on demand'::text;
  end if;

  if a.turn_limit is not null then
    select count(*) into turns from board.events e
    where e.actor = a.id and e.action = 'clock_in' and e.at > now() - make_interval(hours => a.usage_window_hours);
    if turns >= a.turn_limit then
      score := score - 5;
      why := why || 'out of turns this window'::text;
    else
      score := score + (1 - turns::numeric / a.turn_limit) * 1.5;
    end if;
  end if;
  if a.token_budget is not null then
    select coalesce(sum((e.detail ->> 'tokens_used')::bigint), 0) into tokens from board.events e
    where e.actor = a.id and e.action = 'clock_out' and e.detail ? 'tokens_used';
    if tokens >= a.token_budget then
      score := score - 10;
      why := why || 'token budget used up'::text;
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
