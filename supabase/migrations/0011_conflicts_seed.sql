-- House rule 15 (conflicts), the weekly consistency check, and the ZitiSlice lessons from T-117.

insert into board.settings (key, value, updated_at)
select 'house_rules', value || E'\n'
  || '15. When sources disagree (a file and Memory, two files, a message and a task), trust in this order: Fernando''s latest word, then current Memory decisions and rules, then the newest dated file, then older material and chat history. Never silently pick one: call flag_conflict with about, source_a and source_b (say where each one is), adding for: "fernando" when it touches direction, money or legal matters. The task waits while the Supervisor or Fernando decides, and the decision is saved to Memory.',
  now()
from board.settings where key = 'house_rules' and value not like '%flag_conflict%'
on conflict (key) do update set value = excluded.value, updated_at = now();

select cron.schedule('board-consistency', '17 13 * * 1', $$select board.consistency_check()$$);

-- Board-wide until ZitiSlice has its own project. Source: ChatGPT's T-117 briefing (2026-10-24).
select board._add_memory('fernando', 'setup', m, true)
from (values
  ('{"kind":"decision","title":"ZitiSlice: the channel","source_task_id":117,"body":"Fernando''s AI ambience channel is ZitiSlice (youtube.com/@ZitiSlice), his personal channel, named to match his store. Tone: calm, cozy ambience for studying, working, unwinding and sleep; no talking. The bio is live; shop link, banner and profile picture still need the store URL and logo."}'::jsonb),
  ('{"kind":"rule","title":"ZitiSlice: visuals","source_task_id":117,"body":"Loops must be seamless. No fake-looking plants: start from a believable base image before animating. Before generating a new scene, check the existing Higgsfield assets first; a scene for the first video already exists."}'::jsonb),
  ('{"kind":"decision","title":"ZitiSlice: first video","source_task_id":117,"body":"First video plan (Oct 22): the existing Higgsfield scene, looped, with about one hour of lo-fi chill music. As of Oct 24 no finished loop, soundtrack or upload was confirmed."}'::jsonb),
  ('{"kind":"failed","title":"ZitiSlice: music tools","source_task_id":117,"body":"Higgsfield generate_audio makes speech, not music, and sonilo_music is game-pipeline only. Find another music route with cleared rights; no new paid service without Fernando."}'::jsonb),
  ('{"kind":"rule","title":"ZitiSlice: numbers","source_task_id":117,"body":"The Channel earnings analysis chat was about a different channel (Lofi Coffee). Never use its views, subscribers or revenue as ZitiSlice figures."}'::jsonb)
) v(m)
where not exists (select 1 from board.memory where title like 'ZitiSlice:%');
