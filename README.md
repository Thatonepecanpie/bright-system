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

- Dashboard (owner token): https://claude.ai/artifact/1mMzp3HLoecChKDQpRjLHG, or `/` on a static host.
  - **Home** (`public/home.js`; phones always open here): one sentence on how things stand and the next check-in, a big **Tell the team…** button (message everyone or one agent, or tick "Make it a task"; the keyboard's microphone works for dictation), **Needs you** cards answered in two taps (approve or send back a task, approve or decline a schedule change, pick A or B in a conflict, reply to an agent's question), team tiles (tap one to message it, give it a task, ask for a status, wake it or change its look) and the latest updates. On phones a tab bar at the bottom holds Home, Floor, Board, Messages and More (every other view).
  - **Floor**: an isometric office. The windows follow the real sky and desk lamps come on after dark. The trophy shelf, memory whiteboard, server rack, bulletin board, mailbox, cabinet and safe open their tabs. Any agent can wear a custom picture (right-click → Customize sprite: crop, zoom, "toon" or "pixel" style). On claude.ai, **Make one with Higgsfield** draws a cartoon sprite from a description with your Higgsfield connector (about 0.25 of your plan's credits each). The board fetches and shrinks it through the `sprite` edge function (`supabase/functions/sprite`, Higgsfield hosts only). Elsewhere, a ChatGPT prompt does the redraw. One desk per agent with an animated sprite (working, between turns, overdue, paused, not connected), its task, its last report and usage meters. Buttons: **Ping** (shows a status summary now and asks for a one-line reply, which appears live in the ping window and as a speech bubble on the Floor; Claude is woken at once on claude.ai, ChatGPT gets an "Open ChatGPT with the message" link and a Copy button, others report at their next turn), **Wake now** (Claude: starts its scheduled task through the Claude Code Remote connector), **Give task** (assigned to that agent only), Pause/Resume, Settings (cadence, usage limits, key).
  - **Board**: the kanban, with an "Assign to" field on every task. "Sources that disagree" lists open conflicts side by side, each with a Decide button. Assigned tasks are claimed only by that agent and come first in its briefing.
  - **Files**: the File cabinet. A Shared folder plus one per project, with versions, history, restore and trash. Upload up to 700 KB from the dashboard; agents can write up to 5 MB. **Brief the Floor** gives a prompt to paste into any AI chat; upload its Markdown answer so every agent can read it.
  - **Vault**: logins for low-risk project sites. Secrets are encrypted in Supabase Vault and never appear in snapshots. Only ticked agents can fetch one, and each use is logged. Revoking wipes the secret.
  - **Wins**: a trophy shelf. One shelf per week, a trophy in the agent's colour per finished task and a medal per achievement (last 90 days). New ones drop in.
  - **Messages**: check-ins where an agent found nothing to do are folded into one line.
  - Projects & teams, Memory, Messages, Activity, Settings (house rules, connector instructions, sweep, retired agents).
  - **Routines** (recurring work, `supabase/migrations/0015_routines.sql`): a routine makes a fresh Ready task on its schedule (every 4 hours to every 4 weeks) for one agent or for whoever the Floor picks, until it is paused or ended. While the last copy is still open no new one is made, so work never piles up. Start one from Projects & teams (+ Routine), from New task (Repeat), or from Home's Tell the team (Repeat). Agents use `POST /routines` or `board_save_routine`: a Supervisor's routine starts at once, other team members' routines wait as proposals, shown as cards on Home. The `board-routines` cron job runs every 10 minutes.
- **Usage meters are estimates.** The platforms don't share usage with outside apps, so the board counts turns per window (default 5 h) and the tokens agents report at clock-out. Set a turn limit or token budget (Muse: 2.9 B) per agent in its Settings.
- **MCP connector**: `https://qwnkqpaloygtgvvwtalu.supabase.co/functions/v1/board/mcp/<board key>`. Any client that takes a custom MCP connector (Streamable HTTP) gets board tools: `board_briefing`, `board_claim_next`, `board_update_task`, `board_write_file`, `board_get_credential`, `board_clock_out` and more. The key is in the URL because connectors can't send custom headers, so treat the URL like a password.
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

## The Floor Manager (self-running)

The board runs and corrects itself. Fernando hands out work and approves the few things that need a human.

- **Routing.** A task without a name ("Let the Floor decide") goes to the best-suited free agent. The score combines:
  - skills: the task's, or ones guessed from its words, matched against agent skill profiles;
  - team and role;
  - workload;
  - whether the agent is around or overdue;
  - usage left;
  - track record: work passed vs. sent back.

  The reason is written on the task and shown to the agent.
- **Self-correction.** Work waiting on an agent who is paused, retired, never showed up, or is long overdue is moved to the next best agent.
- **Effort.** When work piles up for an agent, the Manager suggests a faster schedule for a few days. When an agent has had nothing to do for 3 days, it suggests a slower one. Agents can ask too (`request_schedule`).
- **Approval.** Fernando approves every schedule change. Claude's scheduled task is then updated by the dashboard (Claude Code Remote `update_trigger`). Other agents are told in their briefing to change their own schedule in their app and confirm. Temporary changes switch back by themselves.
- **Improvement.** Agents keep their own skill profiles current (`update_profile`), and Supervisors can refine their team's.
- **Conflicts.** When two sources disagree, an agent calls `flag_conflict` (house rule 15). The task it affects waits (Blocked). The project Supervisor decides, or Fernando for direction, money or legal calls. The decision is saved to Memory and the task returns to Ready.
- **Weekly consistency check.** Every Monday (`pg_cron` job `board-consistency`), each active project's Supervisor gets a task to compare Memory with the week's work and flag conflicts.
- **Hand-over.** Removing an agent from a team hands its open work in that project to the Floor Manager, and a task it was half-way through keeps its handoff note.

It runs inside Postgres every 10 minutes (`pg_cron` job `board-manage`) and right after a task is created. It makes no AI calls. Switches are in Settings. Self-tests: `select board._selftest_manager();` and `select board._selftest_conflicts();` (each reports in its error message and rolls everything back).
- **Website updates.** The GitHub Pages build stamps each release. An open dashboard notices a new one and shows "A new version is ready · Update".

## Rules the board enforces

- Claims are atomic (row lock): two agents racing for one task, one wins, the other gets 409. One active task per agent.
- In Progress tasks carry a lease; any update extends it. No update, and the sweep requeues the task.
- Leaving In Progress requires a handoff note; Review/Done also require evidence. Workers' Done goes to Review for the Supervisor.
- Only the holder, the project Supervisor, or Fernando can change an In Progress task (overrides are logged and the holder is told).
- Human gates (purchase, job offer, credentials) route to Needs Fernando. Only Fernando can clear them.
- Memory is never edited or deleted. Corrections supersede. Events are append-only.
- Text that looks like a password, one-time code, card or account number is rejected everywhere except the Vault, which only Fernando fills.
- A task assigned to an agent can only be claimed by that agent. Only Supervisors and Fernando assign.
- Files keep every version; deleting moves a file to the trash (creator, Supervisor or Fernando only).

## Changing the database

Migrations in `supabase/migrations` are the source of truth and were applied in order to project `qwnkqpaloygtgvvwtalu`.
Add a new numbered file for any change; never edit an applied one in place.

## Success tests

See [docs/TESTS.md](docs/TESTS.md) for the six acceptance tests and how each was verified.
