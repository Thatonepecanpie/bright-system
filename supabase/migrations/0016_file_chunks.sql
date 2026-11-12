-- Reading big files in pieces. A post image is about 1.1 MB (1.5 MB as base64), which is a lot for one
-- round trip through the claude.ai connector. When a caller passes "chunk_length" (and optionally
-- "chunk_offset", 0-based, in characters of the stored content), file reads return only that slice of
-- "content", plus "content_length" so the caller knows when it has everything. Without those
-- arguments a read is unchanged. Access rules are the same as before.

create or replace function board._read_file(p_agent text, p jsonb) returns jsonb language plpgsql stable set search_path = '' as $$
declare
  f   board.files;
  v   board.file_versions;
  out jsonb;
  c   text;
  off int;
  len int;
begin
  f := board._find_file(p);
  if p_agent is not null and not board._can_access_project(p_agent, f.project_id) then
    raise exception 'That folder belongs to a project you are not on.' using errcode = 'PT403';
  end if;
  if nullif(p ->> 'version', '') is not null and (p ->> 'version')::int <> f.version then
    select * into v from board.file_versions where file_id = f.id and version = (p ->> 'version')::int;
    if not found then
      raise exception 'Version % of % not found.', p ->> 'version', f.path using errcode = 'PT404';
    end if;
    c := v.content;
    out := board._file_meta(f) || jsonb_build_object('version', v.version, 'mime', v.mime, 'encoding', v.encoding,
      'size_bytes', v.size_bytes, 'note', v.note, 'updated_by', v.written_by, 'updated_at', v.written_at,
      'is_latest', false);
  else
    c := f.content;
    out := board._file_meta(f) || jsonb_build_object('is_latest', true);
  end if;

  if nullif(p ->> 'chunk_length', '') is null then
    return out || jsonb_build_object('content', c);
  end if;
  len := least(greatest((p ->> 'chunk_length')::int, 1), 2000000);
  off := greatest(coalesce(nullif(p ->> 'chunk_offset', '')::int, 0), 0);
  return out || jsonb_build_object('content', substr(c, off + 1, len), 'chunk_offset', off,
    'content_length', length(c));
end $$;
