-- Sprites from Higgsfield: the dashboard generates a picture with the viewer's Higgsfield connector,
-- then asks the board to fetch and shrink it (edge function "sprite", via pg_net) so it can be styled
-- and saved as the agent's sprite. Two owner actions: sprite_fetch starts it, sprite_result polls.
create or replace function public.board_owner(p_token text, p_action text, p_args jsonb default '{}', p_via text default 'dashboard')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  act text := lower(coalesce(p_action, ''));
  p   jsonb := coalesce(p_args, '{}'::jsonb);
  via text := left(coalesce(p_via, 'dashboard'), 200);
  r   jsonb;
  k   text;
  rsp record;
begin
  case act
  when 'snapshot' then
    r := board._owner_mgr(p_token, p_action, p, via);
    return r || jsonb_build_object(
      'conflicts', (select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('project', pr.slug) order by c.id desc), '[]') from (
                      select * from board.conflicts where status = 'open' or resolved_at > now() - interval '14 days'
                      order by id desc limit 40) c left join board.projects pr on pr.id = c.project_id),
      'avatars', (select coalesce(jsonb_object_agg(agent_id, image), '{}') from board.avatars));
  when 'resolve_conflict' then
    perform board._owner(p_token);
    return board._resolve_conflict('fernando', via, p, true);
  when 'save_avatar' then
    perform board._owner(p_token);
    k := lower(trim(p ->> 'agent'));
    if not exists (select 1 from board.agents where id = k) then
      raise exception 'Agent "%" not found.', k using errcode = 'PT404';
    end if;
    if nullif(p ->> 'image', '') is null then
      delete from board.avatars where agent_id = k;
    else
      insert into board.avatars (agent_id, image, updated_at) values (k, p ->> 'image', now())
      on conflict (agent_id) do update set image = excluded.image, updated_at = now();
    end if;
    perform board._log('fernando', via, null, null, 'sprite_changed', jsonb_build_object('agent', k, 'custom', nullif(p ->> 'image', '') is not null));
    return jsonb_build_object('agent', k, 'custom', nullif(p ->> 'image', '') is not null);
  when 'save_assignment' then
    r := board._owner_mgr(p_token, p_action, p, via);
    if coalesce((p ->> 'remove')::boolean, false) then
      r := r || jsonb_build_object('handed_over', board._handover(board._project_id(p ->> 'project'), lower(trim(p ->> 'agent')), via));
    end if;
    return r;
  when 'sprite_fetch' then
    -- Fetches a Higgsfield picture through the sprite edge function; the page polls sprite_result.
    perform board._owner(p_token);
    if coalesce(p ->> 'url', '') !~ '^https://(d8j0ntlcm91z4\.cloudfront\.net|([a-z0-9-]+\.)*higgsfield\.ai)/' then
      raise exception 'Only pictures from Higgsfield can be turned into sprites.' using errcode = 'PT400';
    end if;
    return jsonb_build_object('request_id', net.http_get(
      url := 'https://qwnkqpaloygtgvvwtalu.supabase.co/functions/v1/sprite',
      params := jsonb_build_object('url', p ->> 'url'), timeout_milliseconds := 30000));
  when 'sprite_result' then
    perform board._owner(p_token);
    select * into rsp from net._http_response where id = (p ->> 'request_id')::bigint;
    if not found then
      return jsonb_build_object('pending', true);
    end if;
    begin
      r := rsp.content::jsonb;
    exception when others then
      r := '{}';
    end;
    if rsp.status_code = 200 and r ? 'image' then
      return jsonb_build_object('image', r ->> 'image');
    end if;
    return jsonb_build_object('error', coalesce(r ->> 'error', rsp.error_msg, format('The picture could not be converted (HTTP %s).', rsp.status_code)));
  when 'run_consistency_check' then
    perform board._owner(p_token);
    return board.consistency_check();
  else
    return board._owner_mgr(p_token, p_action, p, via);
  end case;
end $$;

revoke execute on function public.board_owner(text, text, jsonb, text) from public;
grant  execute on function public.board_owner(text, text, jsonb, text) to anon, authenticated;
