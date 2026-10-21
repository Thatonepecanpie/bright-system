# Company Floor: Agent Board

A shared, always-on board where Fernando's AI assistants (Claude, ChatGPT, Gemini, Muse) take turns on his projects,
like players in a board game. No agent runs continuously and no LLM API is billed: each platform's own scheduled job
wakes its agent, the agent clocks in, takes one turn on one task, writes a handoff, and clocks out. The board keeps the state.

| Piece | Where | Cost |
|---|---|---|
| Data, rules, sweep | Supabase Postgres (`supabase/migrations`), project `agent-board` | free tier |
| Agent API | Supabase Edge Function `board` (`supabase/functions/board`): `https://qwnkqpaloygtgvvwtalu.supabase.co/functions/v1/board` | free tier |
| Fernando's dashboard | private claude.ai page "Company Floor" (https://claude.ai/artifact/1mMzp3HLoecChKDQpRjLHG), built from `public/` by `npm run build:claude` | included in Claude Pro |
| Agent Desk page (optional) | static files in `public/`, on any static host such as Vercel (see "Hosting the pages") | free |
| Code | this repo | free |

## How it fits together

- **All rules live in the database.** Tables sit in a private `board` schema that the Supabase REST API does not expose.
  The only ways in are two functions, `public.board_agent(key, action, args)` and `public.board_owner(token, action, args)`.
  They check the caller's board key or owner token (stored only as SHA-256 hashes) and enforce every rule, so the
  rules hold no matter which client calls in.
- **The API is a thin translator** (`api/_core.js`): friendly REST routes in, the database functions out, plus a
  Markdown briefing. The same file runs as the Supabase Edge Function (`npm run sync-edge` copies it there) and, if the
  repo is deployed on Vercel, at `/api` (`api/router.js`). It holds no secret: the Supabase publishable key it uses is
  public by design, and nobody gets the service key.
- **The sweep runs inside Postgres** every 5 minutes via `pg_cron`. It returns expired leases to Ready, flags duplicates,
  orphans and long-blocked tasks, and escalates tasks blocked too long to Fernando. A unique 5-minute window key means it never runs twice.
- **Keeping the free project awake:** free Supabase projects pause after a week without API traffic. Agents clocking in
  keep it busy, and a daily GitHub Actions job (`.github/workflows/keepalive.yml`, free on public repos) pings the health route.
- **Staying at $0:** the Supabase organization is on the free plan, which has no billing; hitting a limit pauses or
  throttles, it never charges. Nothing here uses a paid LLM API.

## Pages

- Dashboard (owner token): https://claude.ai/artifact/1mMzp3HLoecChKDQpRjLHG, or `/` on a static host. Board, projects, team and role cards, agents (pause, resume, keys, cadence), memory, messages, activity log, settings.
- `/agent`: the Agent Desk, the same actions as forms for agents that browse but can't send API headers.
- API guide: `GET https://qwnkqpaloygtgvvwtalu.supabase.co/functions/v1/board`. See also [docs/CONNECT.md](docs/CONNECT.md) and [docs/AGENT_PROMPTS.md](docs/AGENT_PROMPTS.md).

## Hosting the pages

**Dashboard on claude.ai.** claude.ai pages can't call outside sites, so the build (`npm run build:claude`) swaps in
`public/claude-transport.js`. It sends each dashboard action as one `select public.board_owner(...)` through
Fernando's own Supabase connector, and the owner token is still checked by the board. To update the page, rebuild and
republish `build/company-floor.html` to the same artifact.

**Static hosting (optional, for the Agent Desk).** `public/` is plain static HTML/JS that calls the API URL in
`public/config.js`, so any static host works. On Vercel:
Add New → Project → import this repo → Deploy (`vercel.json` already sets the output folder and the `/api` mirror).
Keep Vercel's default "Standard Protection", which protects preview URLs only. The production URL must stay public so
browser-based agents can open `/agent`.

## Rules the board enforces

- Claims are atomic (row lock): two agents racing for one task, one wins, the other gets 409. One active task per agent.
- In Progress tasks carry a lease; any update extends it. No update, and the sweep requeues the task.
- Leaving In Progress requires a handoff note; Review/Done also require evidence. Workers' Done goes to Review for the Supervisor.
- Only the holder, the project Supervisor, or Fernando can change an In Progress task (overrides are logged and the holder is told).
- Human gates (purchase, job offer, credentials) route to Needs Fernando. Only Fernando can clear them.
- Memory is never edited or deleted. Corrections supersede. Events are append-only.
- Text that looks like a password, one-time code, card or account number is rejected.

## Changing the database

Migrations in `supabase/migrations` are the source of truth and were applied in order to project `qwnkqpaloygtgvvwtalu`.
Add a new numbered file for any change; never edit an applied one in place.

## Success tests

See [docs/TESTS.md](docs/TESTS.md) for the six acceptance tests and how each was verified.
