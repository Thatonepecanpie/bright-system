-- Mission control: per-agent assignment, usage tracking, a shared file cabinet, and a credential vault.

alter table board.tasks add column assignee text references board.agents(id);

alter table board.agents
  add column wake_trigger_id    text,
  add column usage_window_hours int not null default 5 check (usage_window_hours between 1 and 168),
  add column turn_limit         int check (turn_limit > 0),
  add column token_budget       bigint check (token_budget > 0),
  add column last_summary       text not null default '',
  add column last_summary_at    timestamptz,
  add column retired_at         timestamptz;

create index events_actor_action on board.events (actor, action, at desc);

-- File cabinet. project_id null = the Shared folder every agent can use.
-- board.files holds the current version; board.file_versions keeps every version ever written.
create table board.files (
  id          bigint generated always as identity primary key,
  project_id  bigint references board.projects(id),
  path        text not null check (path ~ '^[A-Za-z0-9][A-Za-z0-9._ ()/-]{0,199}$' and path !~ '\.\.' and path !~ '/$'),
  mime        text not null default 'text/plain',
  encoding    text not null default 'utf8' check (encoding in ('utf8', 'base64')),
  content     text not null default '',
  size_bytes  int  not null default 0 check (size_bytes <= 5242880),
  version     int  not null default 1,
  note        text not null default '',
  created_by  text not null,
  created_at  timestamptz not null default now(),
  updated_by  text not null,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  text
);
create unique index files_live_path on board.files (coalesce(project_id, 0), lower(path)) where deleted_at is null;

create table board.file_versions (
  id          bigint generated always as identity primary key,
  file_id     bigint not null references board.files(id),
  version     int not null,
  mime        text not null,
  encoding    text not null,
  content     text not null,
  size_bytes  int not null,
  note        text not null default '',
  written_by  text not null,
  written_at  timestamptz not null default now(),
  unique (file_id, version)
);
create trigger file_versions_no_change before update or delete on board.file_versions for each row execute function board._deny();

-- Credential vault. The secret itself lives encrypted in Supabase Vault (vault.secrets);
-- this table holds who may use it. Only Fernando adds secrets; agents get one only if granted.
create table board.credentials (
  id             bigint generated always as identity primary key,
  name           text not null unique check (name ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  project_id     bigint references board.projects(id),
  site_url       text not null default '',
  username       text not null default '',
  secret_id      uuid not null,
  notes          text not null default '',
  allowed_agents text[] not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  last_used_by   text,
  use_count      int not null default 0,
  revoked_at     timestamptz
);

alter table board.files         enable row level security;
alter table board.file_versions enable row level security;
alter table board.credentials   enable row level security;

-- The updated house rules are written in 0004 part 1.
