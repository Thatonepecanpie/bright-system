-- Floor Manager, part D: house rules, starter profiles, and the manager's 10-minute run.

insert into board.settings (key, value, updated_at)
select 'house_rules', value || E'\n'
  || '12. The Floor Manager routes open work to the best-suited free agent and moves work that is stuck. A task assigned to you is yours; if it truly does not fit you, say why in a message to supervisor and set it back to ready, and the manager reroutes it.' || E'\n'
  || '13. Keep your skill profile current with update_profile (skills from the list in your briefing, plus a short note on strengths and limits). Supervisors refine their team''s profiles. Routing gets better when profiles are honest.' || E'\n'
  || '14. Schedules: if your workload needs you to run more or less often, call request_schedule (every, reason, optional until). Never change your own schedule without Fernando''s approval. Once approved, change your scheduled task yourself in your own app (a plain instruction is usually enough) and call confirm_schedule.',
  now()
from board.settings where key = 'house_rules' and value not like '%request_schedule%'
on conflict (key) do update set value = excluded.value, updated_at = now();

-- Starter profiles (agents refine their own with update_profile).
select board._update_profile(a, 'setup', p)
from board.agents a join (values
  ('claude', '{"skills":["research","writing","coding","data","planning","review","web"],"profile":"Claude Code scheduled session every 4 hours with a shell, curl and web access. Strong at research, writing, coding, analysis and careful review. Supervisor of onboarding."}'::jsonb),
  ('chatgpt', '{"skills":["research","writing","planning","outreach","data"],"profile":"ChatGPT in the Codex desktop app, connected through the board connector. Runs when Fernando starts it (no schedule yet). Strong at writing, brainstorming and research."}'::jsonb),
  ('gemini', '{"skills":["research","web"],"profile":"Gemini free plan. Not connected yet; capabilities unverified."}'::jsonb),
  ('muse', '{"skills":["research","writing"],"profile":"Muse / Edgar with a free 2.9B-token grant. Not connected yet; capabilities unverified."}'::jsonb)
) v(id, p) on v.id = a.id
where a.profile = '';

select cron.schedule('board-manage', '2-59/10 * * * *', $$select board.manage('manager')$$);
