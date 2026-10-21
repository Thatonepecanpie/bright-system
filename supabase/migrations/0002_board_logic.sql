-- Agent Board: logic. Every rule the board enforces lives here, so it holds no matter
-- which client (REST API, web page, dashboard, a future MCP server) calls in.
-- Errors use PostgREST's PTxxx codes so the HTTP status is meaningful (PT403 -> 403, ...).

alter default privileges in schema board revoke execute on functions from public;

-- ---------- helpers ----------

create function board._hash(p text) returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex')
$$;

create function board._norm(p text) returns text language sql immutable set search_path = '' as $$
  select lower(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g'))
$$;

create function board._now_label() returns text language sql stable set search_path = '' as $$
  select to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI "UTC"')
$$;

-- Backstop for the "no secrets on the board" rule. URLs are ignored so long ids in links pass.
create function board._check_secrets(p text) returns void language plpgsql set search_path = '' as $$
declare s text;
begin
  if p is null or p = '' then return; end if;
  s := regexp_replace(p, 'https?://\S+', ' ', 'gi');
  if s ~* '(password|passcode|passwd|one[- ]?time (pass)?code|\motp\M|2fa code|verification code|security code|\mcvv\M|\mcvc\M)\s*[:=]\s*\S{3,}' then
    raise exception 'Refused: this text looks like it contains a password or one-time code. Never store secrets on the board.'
      using errcode = 'PT400';
  end if;
  if s ~ '\d{12,}' or s ~ '\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}' then
    raise exception 'Refused: this text contains a long number that looks like a card or account number. Never store those on the board.'
      using errcode = 'PT400';
  end if;
end $$;

create function board._looks_gated(p text) returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p, '') ~* '\m(buy|purchase|pay|payment|checkout|subscribe|subscription|job offer|offer letter|contract|password|one-time code|otp|2fa|credit card|bank account)\M'
$$;

create function board._log(p_actor text, p_via text, p_project bigint, p_task bigint, p_action text, p_detail jsonb default '{}')
returns void language sql set search_path = '' as $$
  insert into board.events (actor, via, project_id, task_id, action, detail)
  values (p_actor, coalesce(p_via, ''), p_project, p_task, p_action, coalesce(p_detail, '{}'::jsonb));
$$;

create function board._system_msg(p_project bigint, p_task bigint, p_to text, p_body text)
returns void language sql set search_path = '' as $$
  insert into board.messages (project_id, task_id, author, to_agent, kind, body)
  values (p_project, p_task, 'board', p_to, 'system', left(p_body, 4000));
$$;

create function board._agent(p_key text) returns board.agents language plpgsql set search_path = '' as $$
declare a board.agents;
begin
  if p_key is null or length(p_key) < 20 then
    raise exception 'Missing or malformed board key. Send it as "Authorization: Bearer <key>".' using errcode = 'PT401';
  end if;
  select * into a from board.agents where key_hash = board._hash(p_key);
  if not found then
    raise exception 'Unknown board key.' using errcode = 'PT401';
  end if;
  if a.status <> 'active' then
    raise exception 'Agent "%" is paused by Fernando. Do nothing else; clock out now.', a.id using errcode = 'PT403';
  end if;
  return a;
end $$;

create function board._owner(p_token text) returns bigint language plpgsql set search_path = '' as $$
declare tid bigint;
begin
  select id into tid from board.owner_tokens
  where token_hash = board._hash(p_token) and revoked_at is null;
  if tid is null then
    raise exception 'Invalid owner token.' using errcode = 'PT401';
  end if;
  return tid;
end $$;

create function board._project_id(p text) returns bigint language plpgsql stable set search_path = '' as $$
declare pid bigint;
begin
  if p is null or trim(p) = '' then
    raise exception 'A project (slug) is required.' using errcode = 'PT400';
  end if;
  select id into pid from board.projects where slug = lower(trim(p)) or id::text = trim(p);
  if pid is null then
    raise exception 'Project "%" not found.', p using errcode = 'PT404';
  end if;
  return pid;
end $$;

create function board._task_id(p jsonb) returns bigint language plpgsql immutable set search_path = '' as $$
declare s text := regexp_replace(coalesce(p ->> 'id', p ->> 'task_id', ''), '\D', '', 'g');
begin
  if s = '' then
    raise exception 'A task id is required (e.g. 123 or "T-123").' using errcode = 'PT400';
  end if;
  return s::bigint;
end $$;

create function board._ids(p jsonb) returns bigint[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(regexp_replace(x, '\D', '', 'g')::bigint), '{}')
  from jsonb_array_elements_text(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) x
  where regexp_replace(x, '\D', '', 'g') <> ''
$$;

create function board._is_sup(p_agent text, p_project bigint) returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from board.projects where id = p_project and supervisor = p_agent)
$$;

create function board._deps_done(t board.tasks) returns boolean language sql stable set search_path = '' as $$
  select not exists (select 1 from board.tasks d where d.id = any (t.depends_on) and d.status <> 'done')
$$;

-- May this agent claim this task? Role must match (or the task is tagged 'any'), project must be active.
create function board._can_work(p_agent text, t board.tasks) returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from board.projects p where p.id = t.project_id and p.status = 'active')
     and (
       exists (select 1 from board.assignments s
               where s.project_id = t.project_id and s.agent_id = p_agent and (s.role = t.role_tag or t.role_tag = 'any'))
       or (t.role_tag in ('supervisor', 'any') and board._is_sup(p_agent, t.project_id))
     )
$$;

-- Does any active agent hold the role this task needs?
create function board._has_worker(t board.tasks) returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from board.assignments s join board.agents a on a.id = s.agent_id
                 where s.project_id = t.project_id and a.status = 'active' and (s.role = t.role_tag or t.role_tag = 'any'))
      or (t.role_tag in ('supervisor', 'any')
          and exists (select 1 from board.projects p join board.agents a on a.id = p.supervisor
                      where p.id = t.project_id and a.status = 'active'))
$$;

create function board._tj(t board.tasks) returns jsonb language sql stable set search_path = '' as $$
  select to_jsonb(t) || jsonb_build_object(
    'ref', 'T-' || t.id,
    'project', (select slug from board.projects where id = t.project_id),
    'depends_on_open', (select coalesce(jsonb_agg('T-' || d.id), '[]') from board.tasks d
                        where d.id = any (t.depends_on) and d.status <> 'done'))
$$;

-- ---------- tasks ----------

create function board._create_task(p_actor text, p_via text, p jsonb, p_is_owner boolean)
returns jsonb language plpgsql set search_path = '' as $$
declare
  pid    bigint := board._project_id(p ->> 'project');
  is_sup boolean := not p_is_owner and board._is_sup(p_actor, pid);
  st     text := lower(coalesce(nullif(p ->> 'status', ''), case when p_is_owner or is_sup then 'ready' else 'backlog' end));
  gate   text := nullif(lower(p ->> 'human_gate'), '');
  ttl    text := trim(coalesce(p ->> 'title', ''));
  t      board.tasks;
  note   text := '';
begin
  if not p_is_owner and not is_sup
     and not exists (select 1 from board.assignments where project_id = pid and agent_id = p_actor) then
    raise exception 'You are not assigned to project "%".', p ->> 'project' using errcode = 'PT403';
  end if;
  if st not in ('backlog', 'ready') then
    raise exception 'New tasks start in backlog or ready.' using errcode = 'PT400';
  end if;
  if not p_is_owner and not is_sup and st <> 'backlog' then
    st := 'backlog';
    note := 'Workers create tasks in Backlog; the Supervisor promotes them to Ready.';
  end if;
  perform board._check_secrets(ttl || ' ' || coalesce(p ->> 'description', '') || ' ' || coalesce(p ->> 'next_action', ''));

  insert into board.tasks (project_id, title, description, role_tag, status, priority, depends_on,
                           due_date, next_action, human_gate, created_by, flags)
  values (pid, ttl, coalesce(p ->> 'description', ''),
          coalesce(nullif(lower(trim(p ->> 'role_tag')), ''), 'any'), st,
          coalesce(nullif(p ->> 'priority', '')::int, 2), board._ids(p -> 'depends_on'),
          nullif(p ->> 'due_date', '')::date, coalesce(p ->> 'next_action', ''), gate, p_actor,
          case when gate is null and board._looks_gated(ttl || ' ' || coalesce(p ->> 'description', ''))
               then '{possible_human_gate}'::text[] else '{}'::text[] end)
  returning * into t;

  perform board._log(p_actor, p_via, pid, t.id, 'task_created', jsonb_build_object('title', t.title, 'status', t.status));
  return board._tj(t) || jsonb_build_object('notice', note);
end $$;

create function board._claim(a board.agents, p_via text, p_task bigint, p_lease int)
returns jsonb language plpgsql set search_path = '' as $$
declare t board.tasks; held bigint;
begin
  select id into held from board.tasks where owner = a.id and status = 'in_progress';
  if held is not null then
    raise exception 'You already hold T-%. Finish it, or release it (status ready), before claiming another.', held
      using errcode = 'PT409';
  end if;

  if p_task is null then
    -- claim-next: highest-priority eligible task; SKIP LOCKED means racing agents get different tasks.
    select * into t from board.tasks x
    where x.status = 'ready' and board._can_work(a.id, x) and board._deps_done(x)
    order by x.priority, x.due_date nulls last, x.id
    limit 1 for update skip locked;
    if not found then
      return jsonb_build_object('claimed', false, 'message', 'No Ready task matches your role right now. Post an update if useful, then clock out.');
    end if;
  else
    -- The row lock makes the claim atomic: a racing claimer waits, then sees the task is no longer Ready.
    select * into t from board.tasks where id = p_task for update;
    if not found then
      raise exception 'Task T-% not found.', p_task using errcode = 'PT404';
    end if;
    if t.status <> 'ready' then
      raise exception 'T-% is not claimable: status is % (owner: %).', t.id, t.status, coalesce(t.owner, 'none')
        using errcode = 'PT409';
    end if;
    if not board._can_work(a.id, t) then
      raise exception 'T-% needs role "%", which you do not hold in this project.', t.id, t.role_tag using errcode = 'PT403';
    end if;
    if not board._deps_done(t) then
      raise exception 'T-% is waiting on unfinished dependencies.', t.id using errcode = 'PT409';
    end if;
  end if;

  update board.tasks set
    status = 'in_progress', owner = a.id, claimed_at = now(), heartbeat_at = now(),
    lease_expires_at = now() + make_interval(mins => p_lease),
    status_changed_at = now(), updated_at = now(),
    flags = array_remove(flags, 'requeued_stale')
  where id = t.id
  returning * into t;

  perform board._log(a.id, p_via, t.project_id, t.id, 'claimed', jsonb_build_object('lease_minutes', p_lease));
  return jsonb_build_object('claimed', true, 'task', board._tj(t),
    'message', format('You hold T-%s until %s unless you update it. Do the work, then update it with a handoff_note and evidence.',
                      t.id, to_char(t.lease_expires_at at time zone 'utc', 'HH24:MI "UTC"')));
end $$;

create function board._update_task(p_actor text, p_via text, p jsonb, p_is_owner boolean)
returns jsonb language plpgsql set search_path = '' as $$
declare
  t          board.tasks;
  proj       board.projects;
  old_status text;
  new_status text;
  prev_owner text;
  is_sup     boolean;
  is_holder  boolean;
  lease      int := least(greatest(coalesce(nullif(p ->> 'lease_minutes', '')::int, 60), 5), 240);
  notice     text := '';
  admin_keys text[] := array['title', 'description', 'role_tag', 'priority', 'due_date', 'depends_on', 'human_gate'];
  k          text;
begin
  select * into t from board.tasks where id = board._task_id(p) for update;
  if not found then
    raise exception 'Task % not found.', p ->> 'id' using errcode = 'PT404';
  end if;
  select * into proj from board.projects where id = t.project_id;
  is_sup     := not p_is_owner and proj.supervisor = p_actor;
  is_holder  := not p_is_owner and t.owner = p_actor and t.status = 'in_progress';
  old_status := t.status;
  prev_owner := t.owner;

  if not (p_is_owner or is_sup or is_holder) then
    raise exception 'T-% is % (owner: %). Only its current holder, the project Supervisor, or Fernando can change it. Post a message instead.',
      t.id, t.status, coalesce(t.owner, 'none') using errcode = 'PT403';
  end if;
  if t.status = 'needs_fernando' and not p_is_owner then
    raise exception 'T-% is waiting on Fernando. Only Fernando can move it.', t.id using errcode = 'PT403';
  end if;
  if not (p_is_owner or is_sup) then
    foreach k in array admin_keys loop
      if p ? k then
        raise exception 'Only the Supervisor or Fernando can change "%". Put the suggestion in your handoff_note or a message.', k
          using errcode = 'PT403';
      end if;
    end loop;
  end if;

  perform board._check_secrets(concat_ws(' ', p ->> 'handoff_note', p ->> 'evidence', p ->> 'next_action',
                                         p ->> 'title', p ->> 'description', p ->> 'note'));

  if p ? 'handoff_note' then t.handoff_note := p ->> 'handoff_note'; end if;
  if p ? 'evidence'     then t.evidence     := p ->> 'evidence';     end if;
  if p ? 'next_action'  then t.next_action  := p ->> 'next_action';  end if;
  if p ? 'title'        then t.title        := trim(p ->> 'title');  end if;
  if p ? 'description'  then t.description  := p ->> 'description'; end if;
  if p ? 'role_tag'     then t.role_tag     := coalesce(nullif(lower(trim(p ->> 'role_tag')), ''), 'any'); end if;
  if p ? 'priority'     then t.priority     := (p ->> 'priority')::int; end if;
  if p ? 'due_date'     then t.due_date     := nullif(p ->> 'due_date', '')::date; end if;
  if p ? 'depends_on'   then t.depends_on   := board._ids(p -> 'depends_on'); end if;
  if p ? 'human_gate' then
    if nullif(p ->> 'human_gate', '') is null and t.human_gate is not null and not p_is_owner then
      raise exception 'Only Fernando can remove a human gate.' using errcode = 'PT403';
    end if;
    t.human_gate := nullif(lower(p ->> 'human_gate'), '');
    t.flags := array_remove(t.flags, 'possible_human_gate');
  end if;

  new_status := lower(coalesce(nullif(p ->> 'status', ''), t.status));
  if new_status not in ('backlog', 'ready', 'in_progress', 'blocked', 'needs_fernando', 'review', 'done') then
    raise exception 'Unknown status "%". Use backlog, ready, blocked, needs_fernando, review or done.', new_status using errcode = 'PT400';
  end if;

  if new_status <> old_status then
    if new_status = 'in_progress' then
      raise exception 'Nobody can be put In Progress by an update; the worker claims the task.' using errcode = 'PT400';
    end if;
    if not p_is_owner then
      if old_status = 'in_progress' and trim(t.handoff_note) = '' then
        raise exception 'Write a handoff_note before moving T-% out of In Progress, so the next agent can continue without asking.', t.id
          using errcode = 'PT400';
      end if;
      if new_status in ('review', 'done') and old_status = 'in_progress' and trim(t.evidence) = '' then
        raise exception 'Add evidence (a link, file path or result) before sending T-% to %.', t.id, new_status using errcode = 'PT400';
      end if;
      if new_status = 'backlog' and not is_sup then
        raise exception 'Only the Supervisor can move tasks to Backlog.' using errcode = 'PT403';
      end if;
      if new_status = 'done' and t.human_gate is not null then
        new_status := 'needs_fernando';
        notice := format('T-%s has a human gate (%s), so it went to Needs Fernando instead of Done.', t.id, t.human_gate);
      elsif new_status = 'done' and not is_sup and proj.supervisor is not null then
        new_status := 'review';
        notice := format('T-%s went to Review for Supervisor (%s) QA.', t.id, proj.supervisor);
      end if;
    end if;
  end if;

  if new_status <> old_status then
    t.status := new_status;
    t.status_changed_at := now();
    t.lease_expires_at := null;
    if new_status in ('ready', 'backlog') then t.owner := null; end if;
    if old_status = 'blocked' then t.flags := array_remove(t.flags, 'long_blocked'); end if;
  elsif t.status = 'in_progress' and is_holder then
    t.heartbeat_at := now();
    t.lease_expires_at := now() + make_interval(mins => lease);
  end if;

  update board.tasks set
    title = t.title, description = t.description, role_tag = t.role_tag, status = t.status, owner = t.owner,
    priority = t.priority, depends_on = t.depends_on, due_date = t.due_date, next_action = t.next_action,
    handoff_note = t.handoff_note, evidence = t.evidence, human_gate = t.human_gate, flags = t.flags,
    heartbeat_at = t.heartbeat_at, lease_expires_at = t.lease_expires_at,
    status_changed_at = t.status_changed_at, updated_at = now()
  where id = t.id
  returning * into t;

  perform board._log(p_actor, p_via, t.project_id, t.id,
    case when old_status = 'in_progress' and prev_owner is distinct from p_actor and new_status <> old_status
         then 'override' when new_status <> old_status then 'status_changed' else 'updated' end,
    jsonb_build_object('from', old_status, 'to', t.status,
                       'fields', (select coalesce(jsonb_agg(x), '[]') from jsonb_object_keys(p) x where x not in ('id', 'task_id')),
                       'notice', nullif(notice, '')));

  if old_status = 'in_progress' and prev_owner is distinct from p_actor and t.status <> old_status then
    perform board._system_msg(t.project_id, t.id, prev_owner,
      format('%s moved your task T-%s "%s" from In Progress to %s.', p_actor, t.id, t.title, t.status));
  end if;
  if t.status = 'needs_fernando' and old_status <> 'needs_fernando' then
    perform board._system_msg(t.project_id, t.id, 'fernando',
      format('T-%s "%s" needs your decision. %s', t.id, t.title, coalesce(nullif(t.handoff_note, ''), '')));
  end if;
  if nullif(trim(p ->> 'note'), '') is not null then
    insert into board.messages (project_id, task_id, author, kind, body)
    values (t.project_id, t.id, p_actor, 'update', left(p ->> 'note', 4000));
  end if;

  return board._tj(t) || jsonb_build_object('notice', notice);
end $$;

-- ---------- messages & memory ----------

create function board._post_message(p_actor text, p_via text, p jsonb, p_is_owner boolean)
returns jsonb language plpgsql set search_path = '' as $$
declare
  pid  bigint;
  tid  bigint;
  dest text := nullif(lower(trim(p ->> 'to')), '');
  kind text := lower(coalesce(nullif(p ->> 'kind', ''), 'update'));
  body text := trim(coalesce(p ->> 'body', ''));
  m    board.messages;
begin
  if body = '' then
    raise exception 'Message body is required.' using errcode = 'PT400';
  end if;
  if kind = 'system' then
    raise exception 'Kind must be update, blocker, achievement, feedback, question or answer.' using errcode = 'PT400';
  end if;
  if coalesce(p ->> 'task_id', p ->> 'task') is not null then
    tid := regexp_replace(coalesce(p ->> 'task_id', p ->> 'task'), '\D', '', 'g')::bigint;
    select project_id into pid from board.tasks where id = tid;
    if pid is null then
      raise exception 'Task T-% not found.', tid using errcode = 'PT404';
    end if;
  elsif nullif(p ->> 'project', '') is not null then
    pid := board._project_id(p ->> 'project');
  end if;
  if not p_is_owner and pid is not null
     and not exists (select 1 from board.assignments where project_id = pid and agent_id = p_actor)
     and not board._is_sup(p_actor, pid) then
    raise exception 'You are not on that project.' using errcode = 'PT403';
  end if;
  if dest = 'supervisor' then
    select supervisor into dest from board.projects where id = pid;
  end if;
  if dest is not null and dest <> 'fernando' and not exists (select 1 from board.agents where id = dest) then
    raise exception 'Unknown recipient "%". Use an agent id, "supervisor", "fernando", or omit for everyone.', dest using errcode = 'PT400';
  end if;
  perform board._check_secrets(body);

  insert into board.messages (project_id, task_id, author, to_agent, kind, body)
  values (pid, tid, p_actor, dest, kind, left(body, 4000))
  returning * into m;
  perform board._log(p_actor, p_via, pid, tid, 'message', jsonb_build_object('message_id', m.id, 'kind', kind, 'to', dest));
  return to_jsonb(m);
end $$;

create function board._add_memory(p_actor text, p_via text, p jsonb, p_is_owner boolean)
returns jsonb language plpgsql set search_path = '' as $$
declare
  pid   bigint;
  prev  board.memory;
  m     board.memory;
  kind  text := lower(coalesce(nullif(p ->> 'kind', ''), 'fact'));
  body  text := trim(coalesce(p ->> 'body', ''));
  sup_id bigint := nullif(regexp_replace(coalesce(p ->> 'supersedes', ''), '\D', '', 'g'), '')::bigint;
begin
  if nullif(p ->> 'project', '') is not null then
    pid := board._project_id(p ->> 'project');
  end if;
  if not p_is_owner then
    if pid is null then
      raise exception 'Agents write memory to a project; board-wide memory is Fernando''s.' using errcode = 'PT403';
    end if;
    if not exists (select 1 from board.assignments where project_id = pid and agent_id = p_actor)
       and not board._is_sup(p_actor, pid) then
      raise exception 'You are not on that project.' using errcode = 'PT403';
    end if;
  end if;
  perform board._check_secrets(coalesce(p ->> 'title', '') || ' ' || body);

  if sup_id is not null then
    select * into prev from board.memory where id = sup_id for update;
    if not found then
      raise exception 'Memory #% not found.', sup_id using errcode = 'PT404';
    end if;
    if prev.superseded_by is not null then
      raise exception 'Memory #% was already superseded by #%. Supersede that one instead.', prev.id, prev.superseded_by
        using errcode = 'PT409';
    end if;
    if prev.project_id is distinct from pid then
      raise exception 'A correction must be in the same project as the entry it supersedes.' using errcode = 'PT400';
    end if;
    if not p_is_owner and prev.author <> p_actor and not board._is_sup(p_actor, pid) then
      raise exception 'Only the author, the Supervisor, or Fernando can supersede memory #%. Message the Supervisor instead.', prev.id
        using errcode = 'PT403';
    end if;
  end if;

  insert into board.memory (project_id, kind, title, body, author, source_task_id, supersedes)
  values (pid, kind, trim(coalesce(p ->> 'title', '')), body, p_actor,
          nullif(regexp_replace(coalesce(p ->> 'source_task_id', ''), '\D', '', 'g'), '')::bigint, sup_id)
  returning * into m;

  if sup_id is not null then
    update board.memory set superseded_by = m.id where id = sup_id;
  end if;
  perform board._log(p_actor, p_via, pid, m.source_task_id,
    case when sup_id is null then 'memory_added' else 'memory_superseded' end,
    jsonb_build_object('memory_id', m.id, 'supersedes', sup_id));
  return to_jsonb(m);
end $$;

-- ---------- the briefing: everything an agent needs for one turn, in one read ----------

create function board._briefing(a board.agents, p_via text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  projs     bigint[];
  sup_projs bigint[];
  asg       jsonb;
  active    jsonb;
  nexts     jsonb;
  mem       jsonb;
  msgs      jsonb;
  last_msg  bigint;
  more      int;
  sup       jsonb;
  move      text;
begin
  update board.agents set last_seen_at = now() where id = a.id;
  perform board._log(a.id, p_via, null, null, 'clock_in');

  select coalesce(array_agg(distinct pid), '{}') into projs from (
    select s.project_id pid from board.assignments s join board.projects p on p.id = s.project_id
    where s.agent_id = a.id and p.status = 'active'
    union
    select id from board.projects where supervisor = a.id and status = 'active') x;
  select coalesce(array_agg(id), '{}') into sup_projs from board.projects where supervisor = a.id and status = 'active';

  select coalesce(jsonb_agg(jsonb_build_object(
           'project', p.slug, 'project_name', p.name, 'goal', p.goal, 'supervisor', p.supervisor,
           'you_are_supervisor', p.supervisor = a.id,
           'role', s.role, 'scope', s.scope, 'tools_allowed', s.tools_allowed, 'can_do_alone', s.can_do_alone,
           'needs_approval', s.needs_approval, 'escalate_when', s.escalate_when,
           'supervisor_card', case when p.supervisor = a.id then p.supervisor_card end) order by p.slug), '[]')
  into asg
  from board.projects p left join board.assignments s on s.project_id = p.id and s.agent_id = a.id
  where p.id = any (projs);

  select board._tj(t) into active from board.tasks t where t.owner = a.id and t.status = 'in_progress';

  select coalesce(jsonb_agg(j order by pr, dd nulls last, id), '[]') into nexts from (
    select board._tj(t) j, t.priority pr, t.due_date dd, t.id from board.tasks t
    where t.status = 'ready' and t.project_id = any (projs) and board._can_work(a.id, t) and board._deps_done(t)
    order by t.priority, t.due_date nulls last, t.id limit 5) x;

  select coalesce(jsonb_agg(j order by created_at desc), '[]') into mem from (
    select jsonb_build_object('id', m.id, 'project', p.slug, 'kind', m.kind, 'title', m.title, 'body', m.body,
                              'author', m.author, 'source_task', m.source_task_id, 'supersedes', m.supersedes,
                              'date', m.created_at::date) j, m.created_at
    from board.memory m left join board.projects p on p.id = m.project_id
    where m.superseded_by is null and (m.project_id is null or m.project_id = any (projs))
    order by m.created_at desc limit 40) x;

  select coalesce(jsonb_agg(j order by id), '[]'), max(id) into msgs, last_msg from (
    select jsonb_build_object('id', m.id, 'at', m.created_at, 'from', m.author, 'to', m.to_agent, 'kind', m.kind,
                              'project', p.slug, 'task', case when m.task_id is not null then 'T-' || m.task_id end,
                              'body', m.body) j, m.id
    from board.messages m left join board.projects p on p.id = m.project_id
    where m.id > a.msg_cursor and m.author <> a.id
      and (m.to_agent is null or m.to_agent = a.id)
      and (m.project_id is null or m.project_id = any (projs))
    order by m.id limit 30) x;
  if last_msg is not null then
    update board.agents set msg_cursor = last_msg where id = a.id;
    select count(*) into more from board.messages m
    where m.id > last_msg and m.author <> a.id and (m.to_agent is null or m.to_agent = a.id)
      and (m.project_id is null or m.project_id = any (projs));
  end if;

  if cardinality(sup_projs) > 0 then
    sup := jsonb_build_object(
      'review',  (select coalesce(jsonb_agg(board._tj(t) order by t.id), '[]') from board.tasks t
                  where t.project_id = any (sup_projs) and t.status = 'review'),
      'blocked', (select coalesce(jsonb_agg(board._tj(t) order by t.id), '[]') from board.tasks t
                  where t.project_id = any (sup_projs) and t.status = 'blocked'),
      'flagged', (select coalesce(jsonb_agg(board._tj(t) order by t.id), '[]') from board.tasks t
                  where t.project_id = any (sup_projs) and t.status <> 'done' and cardinality(t.flags) > 0),
      'backlog_to_triage', (select coalesce(jsonb_agg(j), '[]') from (
                  select board._tj(t) j from board.tasks t
                  where t.project_id = any (sup_projs) and t.status = 'backlog' order by t.priority, t.id limit 10) x),
      'needs_fernando_count', (select count(*) from board.tasks t
                  where t.project_id = any (sup_projs) and t.status = 'needs_fernando'));
  end if;

  move := case
    when active is not null then format(
      'You hold %s. Continue it. Every update extends your lease. When finished: update it with status "done" (or "review"), a handoff_note and evidence. If you cannot finish this turn: update the handoff_note and either leave it In Progress or release it with status "ready".',
      active ->> 'ref')
    when jsonb_array_length(nexts) > 0 then
      'Claim exactly one task (POST /api/claim-next, or POST /api/tasks/<id>/claim), do it, then update it with a handoff_note and evidence.'
    else 'No Ready task matches your role right now.'
  end;
  if sup is not null and (jsonb_array_length(sup -> 'review') + jsonb_array_length(sup -> 'blocked')
                          + jsonb_array_length(sup -> 'flagged') + jsonb_array_length(sup -> 'backlog_to_triage')) > 0 then
    move := format('Supervisor duties first: %s in Review to QA (pass: status "done"; fail: status "ready" with a note), %s Blocked, %s flagged, %s Backlog to triage. Then: %s',
      jsonb_array_length(sup -> 'review'), jsonb_array_length(sup -> 'blocked'),
      jsonb_array_length(sup -> 'flagged'), jsonb_array_length(sup -> 'backlog_to_triage'), move);
  end if;
  move := move || ' Finish with POST /api/clock-out.';

  return jsonb_build_object(
    'board_time', now(),
    'you', jsonb_build_object('id', a.id, 'name', a.display_name, 'platform', a.platform, 'clock_in_every', a.clock_in_every),
    'your_move', move,
    'house_rules', (select value from board.settings where key = 'house_rules'),
    'assignments', asg,
    'active_task', active,
    'next_tasks', nexts,
    'supervisor', sup,
    'memory', mem,
    'messages', msgs,
    'more_unread_messages', coalesce(more, 0));
end $$;

-- ---------- public entry point for agents ----------

create function public.board_agent(p_key text, p_action text, p_args jsonb default '{}', p_via text default 'api')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a     board.agents := board._agent(p_key);
  p     jsonb := coalesce(p_args, '{}'::jsonb);
  lease int := least(greatest(coalesce(nullif(p ->> 'lease_minutes', '')::int, 60), 5), 240);
  via   text := left(coalesce(p_via, 'api'), 200);
  projs bigint[];
  r     jsonb;
begin
  case lower(coalesce(p_action, ''))
  when 'briefing' then
    return board._briefing(a, via);

  when 'list_tasks' then
    select coalesce(array_agg(distinct pid), '{}') into projs from (
      select project_id pid from board.assignments where agent_id = a.id
      union select id from board.projects where supervisor = a.id) x;
    select coalesce(jsonb_agg(j order by s, pr, id), '[]') into r from (
      select board._tj(t) j, t.status s, t.priority pr, t.id from board.tasks t
      where t.project_id = any (projs)
        and (nullif(p ->> 'project', '') is null or t.project_id = board._project_id(p ->> 'project'))
        and (nullif(p ->> 'status', '') is null or t.status = lower(p ->> 'status'))
        and (t.status <> 'done' or t.updated_at > now() - interval '14 days')
      order by t.id desc limit 200) x;
    return jsonb_build_object('tasks', r);

  when 'get_task' then
    select board._tj(t) || jsonb_build_object(
      'events', (select coalesce(jsonb_agg(to_jsonb(e) order by e.id desc), '[]') from (
                  select * from board.events where task_id = t.id order by id desc limit 30) e),
      'messages', (select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]') from board.messages m where m.task_id = t.id))
    into r
    from board.tasks t where t.id = board._task_id(p)
      and (exists (select 1 from board.assignments s where s.project_id = t.project_id and s.agent_id = a.id)
           or board._is_sup(a.id, t.project_id));
    if r is null then
      raise exception 'Task not found on your projects.' using errcode = 'PT404';
    end if;
    return r;

  when 'claim' then
    return board._claim(a, via, board._task_id(p), lease);
  when 'claim_next' then
    return board._claim(a, via, null, lease);
  when 'update' then
    return board._update_task(a.id, via, p, false);
  when 'create_task' then
    return board._create_task(a.id, via, p, false);
  when 'post_message' then
    return board._post_message(a.id, via, p, false);
  when 'add_memory' then
    return board._add_memory(a.id, via, p, false);
  when 'clock_out' then
    if nullif(trim(p ->> 'summary'), '') is not null then
      perform board._post_message(a.id, via, jsonb_build_object('body', p ->> 'summary', 'kind', 'update', 'project', p ->> 'project'), false);
    end if;
    perform board._log(a.id, via, null, null, 'clock_out');
    return jsonb_build_object('ok', true, 'message', 'Clocked out. See you next turn.');
  else
    raise exception 'Unknown action "%".', p_action using errcode = 'PT400';
  end case;
end $$;

-- ---------- sweep: the mechanical half of supervision ----------

create function board.sweep(p_actor text default 'system', p_force boolean default false)
returns jsonb language plpgsql set search_path = '' as $$
declare
  w         timestamptz := case when p_force then clock_timestamp()
                                else date_trunc('hour', now()) + floor(extract(minute from now()) / 5) * interval '5 minutes' end;
  rid       bigint;
  t         record;
  hrs       int := coalesce((select value::int from board.settings where key = 'blocked_escalate_hours'), 48);
  n_stale   int := 0;
  n_blocked int := 0;
  n_esc     int := 0;
  n_dup     int := 0;
  n_orphan  int := 0;
  res       jsonb;
begin
  insert into board.sweep_runs (window_start, actor) values (w, p_actor)
  on conflict (window_start) do nothing returning id into rid;
  if rid is null then
    return jsonb_build_object('skipped', true, 'window', w, 'reason', 'A sweep already ran in this 5-minute window.');
  end if;

  -- 1. Expired leases go back to Ready.
  for t in select * from board.tasks where status = 'in_progress' and lease_expires_at < now() for update skip locked loop
    update board.tasks set
      status = 'ready', owner = null, lease_expires_at = null, status_changed_at = now(), updated_at = now(),
      flags = array_append(array_remove(flags, 'requeued_stale'), 'requeued_stale'),
      handoff_note = handoff_note || case when handoff_note = '' then '' else E'\n' end
                     || format('[board %s] %s''s lease expired with no update; returned to Ready.', board._now_label(), t.owner)
    where id = t.id;
    perform board._log('system', 'sweep', t.project_id, t.id, 'requeued_stale',
                       jsonb_build_object('previous_owner', t.owner, 'lease_expired_at', t.lease_expires_at));
    perform board._system_msg(t.project_id, t.id, (select supervisor from board.projects where id = t.project_id),
      format('T-%s "%s" went stale (no update from %s before its lease ended) and is back in Ready.', t.id, t.title, t.owner));
    n_stale := n_stale + 1;
  end loop;

  -- 2. Long-blocked: flag after N hours, escalate to Fernando after 2N.
  for t in select * from board.tasks where status = 'blocked' and status_changed_at < now() - make_interval(hours => hrs * 2)
           for update skip locked loop
    update board.tasks set status = 'needs_fernando', status_changed_at = now(), updated_at = now(),
                           flags = array_remove(flags, 'long_blocked')
    where id = t.id;
    perform board._log('system', 'sweep', t.project_id, t.id, 'escalated', jsonb_build_object('blocked_since', t.status_changed_at));
    perform board._system_msg(t.project_id, t.id, 'fernando',
      format('T-%s "%s" has been Blocked for over %s hours and needs your call. Last note: %s', t.id, t.title, hrs * 2, t.handoff_note));
    n_esc := n_esc + 1;
  end loop;
  for t in select * from board.tasks where status = 'blocked' and status_changed_at < now() - make_interval(hours => hrs)
           and not ('long_blocked' = any (flags)) for update skip locked loop
    update board.tasks set flags = array_append(flags, 'long_blocked') where id = t.id;
    perform board._log('system', 'sweep', t.project_id, t.id, 'flagged', '{"flag":"long_blocked"}');
    perform board._system_msg(t.project_id, t.id, (select supervisor from board.projects where id = t.project_id),
      format('T-%s "%s" has been Blocked for over %s hours. Unblock it, requeue it, or escalate it.', t.id, t.title, hrs));
    n_blocked := n_blocked + 1;
  end loop;

  -- 3. Possible duplicates: same project, same normalised title, both open.
  for t in select t1.id, t1.project_id, t1.title,
                  (select min(t2.id) from board.tasks t2 where t2.project_id = t1.project_id and t2.id < t1.id
                     and t2.status <> 'done' and board._norm(t2.title) = board._norm(t1.title)) as original
           from board.tasks t1
           where t1.status <> 'done' and not ('possible_duplicate' = any (t1.flags)) loop
    continue when t.original is null;
    update board.tasks set flags = array_append(flags, 'possible_duplicate') where id = t.id;
    perform board._log('system', 'sweep', t.project_id, t.id, 'flagged', jsonb_build_object('flag', 'possible_duplicate', 'original', t.original));
    perform board._system_msg(t.project_id, t.id, (select supervisor from board.projects where id = t.project_id),
      format('T-%s "%s" looks like a duplicate of T-%s.', t.id, t.title, t.original));
    n_dup := n_dup + 1;
  end loop;

  -- 4. Orphans: Ready tasks whose role nobody active holds.
  for t in select * from board.tasks x where x.status = 'ready' and not ('orphan' = any (x.flags)) and not board._has_worker(x) loop
    update board.tasks set flags = array_append(flags, 'orphan') where id = t.id;
    perform board._log('system', 'sweep', t.project_id, t.id, 'flagged', jsonb_build_object('flag', 'orphan', 'role', t.role_tag));
    perform board._system_msg(t.project_id, t.id, (select supervisor from board.projects where id = t.project_id),
      format('T-%s "%s" needs role "%s" but no active agent holds it.', t.id, t.title, t.role_tag));
    n_orphan := n_orphan + 1;
  end loop;
  update board.tasks x set flags = array_remove(flags, 'orphan')
  where 'orphan' = any (x.flags) and (x.status <> 'ready' or board._has_worker(x));

  res := jsonb_build_object('requeued_stale', n_stale, 'flagged_long_blocked', n_blocked, 'escalated', n_esc,
                            'flagged_duplicates', n_dup, 'flagged_orphans', n_orphan);
  update board.sweep_runs set finished_at = clock_timestamp(), result = res where id = rid;
  if n_stale + n_blocked + n_esc + n_dup + n_orphan > 0 then
    perform board._log(p_actor, 'sweep', null, null, 'sweep', res);
  end if;
  return res || jsonb_build_object('window', w, 'run_id', rid);
end $$;

-- ---------- keys ----------

create function board._issue_agent_key(p_agent text) returns text language plpgsql set search_path = '' as $$
declare k text := 'ab_' || p_agent || '_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  update board.agents set key_hash = board._hash(k), key_hint = right(k, 4) where id = p_agent;
  if not found then
    raise exception 'Agent "%" not found.', p_agent using errcode = 'PT404';
  end if;
  return k;
end $$;

create function board._issue_owner_token(p_label text) returns text language plpgsql set search_path = '' as $$
declare k text := 'own_' || encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into board.owner_tokens (label, token_hash, token_hint) values (p_label, board._hash(k), right(k, 4));
  return k;
end $$;

-- ---------- public entry point for Fernando ----------

create function public.board_owner(p_token text, p_action text, p_args jsonb default '{}', p_via text default 'dashboard')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  tid bigint := board._owner(p_token);
  p   jsonb := coalesce(p_args, '{}'::jsonb);
  via text := left(coalesce(p_via, 'dashboard'), 200);
  pid bigint;
  r   jsonb;
  k   text;
begin
  case lower(coalesce(p_action, ''))
  when 'snapshot' then
    return jsonb_build_object(
      'board_time', now(),
      'agents', (select coalesce(jsonb_agg(to_jsonb(a) - 'key_hash' order by a.id), '[]') from board.agents a),
      'projects', (select coalesce(jsonb_agg(to_jsonb(x) order by x.status, x.name), '[]') from board.projects x),
      'assignments', (select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('project', p2.slug)), '[]')
                      from board.assignments s join board.projects p2 on p2.id = s.project_id),
      'tasks', (select coalesce(jsonb_agg(board._tj(t) order by t.priority, t.id), '[]') from board.tasks t
                join board.projects p3 on p3.id = t.project_id
                where p3.status <> 'archived' and (t.status <> 'done' or t.updated_at > now() - interval '30 days')),
      'memory', (select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object('project', p4.slug) order by m.id desc), '[]')
                 from (select * from board.memory order by id desc limit 300) m left join board.projects p4 on p4.id = m.project_id),
      'messages', (select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object('project', p5.slug) order by m.id desc), '[]')
                   from (select * from board.messages order by id desc limit 150) m left join board.projects p5 on p5.id = m.project_id),
      'events', (select coalesce(jsonb_agg(to_jsonb(e) order by e.id desc), '[]')
                 from (select * from board.events order by id desc limit 200) e),
      'sweeps', (select coalesce(jsonb_agg(to_jsonb(s) order by s.id desc), '[]')
                 from (select * from board.sweep_runs order by id desc limit 5) s),
      'settings', (select coalesce(jsonb_object_agg(key, value), '{}') from board.settings));

  when 'task_detail' then
    select board._tj(t) || jsonb_build_object(
      'events', (select coalesce(jsonb_agg(to_jsonb(e) order by e.id desc), '[]') from board.events e where e.task_id = t.id),
      'messages', (select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]') from board.messages m where m.task_id = t.id))
    into r from board.tasks t where t.id = board._task_id(p);
    if r is null then
      raise exception 'Task not found.' using errcode = 'PT404';
    end if;
    return r;

  when 'save_project' then
    if nullif(p ->> 'id', '') is not null then
      update board.projects set
        name = coalesce(nullif(trim(p ->> 'name'), ''), name),
        goal = coalesce(p ->> 'goal', goal),
        status = coalesce(nullif(p ->> 'status', ''), status),
        supervisor = case when p ? 'supervisor' then nullif(p ->> 'supervisor', '') else supervisor end,
        supervisor_card = coalesce(p ->> 'supervisor_card', supervisor_card),
        updated_at = now()
      where id = (p ->> 'id')::bigint returning id into pid;
      if pid is null then
        raise exception 'Project not found.' using errcode = 'PT404';
      end if;
    else
      insert into board.projects (slug, name, goal, supervisor, supervisor_card)
      values (coalesce(nullif(lower(trim(p ->> 'slug')), ''),
                       trim(both '-' from left(regexp_replace(lower(coalesce(p ->> 'name', '')), '[^a-z0-9]+', '-', 'g'), 48))),
              trim(p ->> 'name'), coalesce(p ->> 'goal', ''), nullif(p ->> 'supervisor', ''), coalesce(p ->> 'supervisor_card', ''))
      returning id into pid;
    end if;
    perform board._log('fernando', via, pid, null, 'project_saved', p);
    return (select to_jsonb(x) from board.projects x where id = pid);

  when 'save_agent' then
    insert into board.agents (id, display_name, platform, status, clock_in_every, notes)
    values (lower(trim(p ->> 'id')), coalesce(nullif(p ->> 'display_name', ''), p ->> 'id'),
            coalesce(nullif(p ->> 'platform', ''), 'unknown'), coalesce(nullif(p ->> 'status', ''), 'active'),
            coalesce(nullif(p ->> 'clock_in_every', ''), 'every 4 hours'), coalesce(p ->> 'notes', ''))
    on conflict (id) do update set
      display_name = coalesce(nullif(p ->> 'display_name', ''), board.agents.display_name),
      platform = coalesce(nullif(p ->> 'platform', ''), board.agents.platform),
      status = coalesce(nullif(p ->> 'status', ''), board.agents.status),
      clock_in_every = coalesce(nullif(p ->> 'clock_in_every', ''), board.agents.clock_in_every),
      notes = coalesce(p ->> 'notes', board.agents.notes);
    perform board._log('fernando', via, null, null, 'agent_saved', p);
    return (select to_jsonb(a) - 'key_hash' from board.agents a where id = lower(trim(p ->> 'id')));

  when 'rotate_agent_key' then
    k := board._issue_agent_key(lower(trim(p ->> 'agent')));
    perform board._log('fernando', via, null, null, 'agent_key_rotated', jsonb_build_object('agent', p ->> 'agent'));
    return jsonb_build_object('agent', p ->> 'agent', 'key', k,
                              'message', 'Copy this key now; the board only stores its hash. The old key no longer works.');

  when 'save_assignment' then
    pid := board._project_id(p ->> 'project');
    if coalesce((p ->> 'remove')::boolean, false) then
      update board.assignment_rows set removed_at = now()
      where project_id = pid and agent_id = p ->> 'agent' and removed_at is null;
      perform board._log('fernando', via, pid, null, 'assignment_removed', p);
      return jsonb_build_object('removed', true);
    end if;
    insert into board.assignment_rows (project_id, agent_id, role, scope, tools_allowed, can_do_alone, needs_approval, escalate_when)
    values (pid, p ->> 'agent', lower(trim(p ->> 'role')), coalesce(p ->> 'scope', ''), coalesce(p ->> 'tools_allowed', ''),
            coalesce(p ->> 'can_do_alone', ''), coalesce(p ->> 'needs_approval', ''), coalesce(p ->> 'escalate_when', ''))
    on conflict (project_id, agent_id) do update set
      role = excluded.role, scope = excluded.scope, tools_allowed = excluded.tools_allowed,
      can_do_alone = excluded.can_do_alone, needs_approval = excluded.needs_approval,
      escalate_when = excluded.escalate_when, removed_at = null, updated_at = now();
    perform board._log('fernando', via, pid, null, 'assignment_saved', p);
    return (select to_jsonb(s) from board.assignments s where project_id = pid and agent_id = p ->> 'agent');

  when 'create_task' then
    return board._create_task('fernando', via, p, true);
  when 'update_task' then
    return board._update_task('fernando', via, p, true);
  when 'post_message' then
    return board._post_message('fernando', via, p, true);
  when 'add_memory' then
    return board._add_memory('fernando', via, p, true);

  when 'save_setting' then
    insert into board.settings (key, value) values (p ->> 'key', p ->> 'value')
    on conflict (key) do update set value = excluded.value, updated_at = now();
    perform board._log('fernando', via, null, null, 'setting_saved', jsonb_build_object('key', p ->> 'key'));
    return jsonb_build_object('ok', true);

  when 'run_sweep' then
    return board.sweep('fernando', true);

  when 'rotate_owner_token' then
    update board.owner_tokens set revoked_at = now() where id = tid;
    k := board._issue_owner_token(coalesce(nullif(p ->> 'label', ''), 'dashboard'));
    perform board._log('fernando', via, null, null, 'owner_token_rotated');
    return jsonb_build_object('token', k, 'message', 'Save this token now. The old one has stopped working.');
  else
    raise exception 'Unknown action "%".', p_action using errcode = 'PT400';
  end case;
end $$;

create function public.board_ping() returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('ok', true, 'board_time', now(),
                            'last_sweep', (select max(finished_at) from board.sweep_runs))
$$;

revoke execute on all functions in schema board from public, anon, authenticated;
revoke execute on function public.board_agent(text, text, jsonb, text) from public;
revoke execute on function public.board_owner(text, text, jsonb, text) from public;
revoke execute on function public.board_ping() from public;
grant  execute on function public.board_agent(text, text, jsonb, text) to anon, authenticated;
grant  execute on function public.board_owner(text, text, jsonb, text) to anon, authenticated;
grant  execute on function public.board_ping() to anon, authenticated;

-- The mechanical sweep runs inside the database every 5 minutes. Scheduling by name is an upsert, so never two jobs.
create extension if not exists pg_cron;
select cron.schedule('board-sweep', '*/5 * * * *', $$select board.sweep('system')$$);
