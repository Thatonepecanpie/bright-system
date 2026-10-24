-- Floor Manager, part A: what the manager needs to know and remember.
--   * agents carry a skill profile, kept current by the agents themselves;
--   * tasks carry the skills they need and why they were routed where they were;
--   * schedule requests: an agent (or the manager) asks to run more or less often, Fernando approves,
--     the agent changes its own scheduled task (Claude's is changed by the dashboard) and confirms.

alter table board.agents
  add column if not exists skills text[] not null default '{}',
  add column if not exists profile text not null default '',
  add column if not exists profile_updated_at timestamptz;

alter table board.tasks
  add column if not exists skills text[] not null default '{}',
  add column if not exists route_reason text not null default '',
  add column if not exists routed_at timestamptz,
  add column if not exists route_count int not null default 0;

create table if not exists board.schedule_requests (
  id            bigint generated always as identity primary key,
  agent_id      text not null references board.agents(id),
  source        text not null default 'agent' check (source in ('agent', 'manager', 'fernando')),
  every         text not null check (length(every) between 3 and 60),
  prev_every    text not null default '',
  reason        text not null default '' check (length(reason) <= 1000),
  until         timestamptz,
  task_id       bigint references board.tasks(id),
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'applied', 'declined', 'cancelled', 'expired', 'reverted')),
  decision_note text not null default '',
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  applied_at    timestamptz,
  expired_at    timestamptz,
  reverted_at   timestamptz
);
create index if not exists schedule_requests_agent on board.schedule_requests (agent_id, status);
alter table board.schedule_requests enable row level security;
revoke all on board.schedule_requests from public, anon, authenticated;

-- Manager switches, editable from the dashboard's Settings.
insert into board.settings (key, value)
values ('manager', '{"auto_route": true, "auto_effort": true}')
on conflict (key) do nothing;
