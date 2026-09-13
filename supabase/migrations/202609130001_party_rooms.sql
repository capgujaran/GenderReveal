-- Gender Reveal hosted rooms. Run once through the Supabase SQL editor or CLI.
-- The browser receives only the public RPC results, never the underlying tables.
-- All writes lock the room first, then its participant, to serialize start/join
-- and finish/reveal races. Scores are bounded client reports; time is server-owned.
begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists party_private;
revoke all on schema party_private from public, anon, authenticated;

create table party_private.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z]{6}$'),
  host_id uuid not null references auth.users(id),
  game text not null check (game in ('words', 'jigsaw')),
  status text not null default 'waiting'
    check (status in ('waiting', 'running', 'revealed')),
  created_at timestamptz not null default clock_timestamp(),
  starts_at timestamptz,
  revealed_at timestamptz,
  check (
    (status = 'waiting' and starts_at is null and revealed_at is null)
    or (status = 'running' and starts_at is not null and revealed_at is null)
    or (status = 'revealed' and starts_at is not null
      and revealed_at is not null and revealed_at >= starts_at)
  )
);

create table party_private.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references party_private.rooms(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 24),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  joined_at timestamptz not null default clock_timestamp(),
  score integer not null default 0 check (score between 0 and 120),
  finished_at timestamptz,
  time_ms bigint check (time_ms >= 0),
  check ((finished_at is null and time_ms is null)
    or (finished_at is not null and time_ms is not null))
);

create index party_rooms_host_created on party_private.rooms(host_id, created_at desc);
create index party_players_room_joined on party_private.players(room_id, joined_at, id);

alter table party_private.rooms enable row level security;
alter table party_private.players enable row level security;
-- No client policies: access is exclusively through the checked definer RPCs.
revoke all on all tables in schema party_private from public, anon, authenticated;
alter default privileges in schema party_private
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema party_private
  revoke execute on functions from public, anon, authenticated;

create function party_private.require_host()
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null
    or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'pradeepb@icai.org'
    or not exists (
      select 1 from auth.users as u
      where u.id = v_uid and lower(u.email) = 'pradeepb@icai.org'
        and u.email_confirmed_at is not null
    ) then
    raise exception 'Sign in with the verified host email to use host controls.'
      using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create function party_private.clean_code(p_code text)
returns text
language plpgsql immutable security definer set search_path = ''
as $$
declare v_code text := upper(btrim(p_code));
begin
  if v_code is null or v_code !~ '^[A-Z]{6}$' then
    raise exception 'Enter the six-letter game code.' using errcode = '22023';
  end if;
  return v_code;
end;
$$;

create function party_private.member_id(p_room uuid, p_token text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_player uuid;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then
    raise exception 'Your game entry is not valid. Join using the game code.'
      using errcode = '42501';
  end if;
  select p.id into v_player from party_private.players as p
  where p.room_id = p_room
    and p.token_hash = extensions.digest(p_token, 'sha256');
  if v_player is null then
    raise exception 'Your game entry is not valid. Join using the game code.'
      using errcode = '42501';
  end if;
  return v_player;
end;
$$;

-- Private helper. Clients cannot set p_host or impersonate p_self.
-- Every caller has already checked host ownership or a participant token.
create function party_private.snapshot(p_room uuid, p_self uuid, p_host boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_room party_private.rooms%rowtype;
  v_players jsonb;
  v_self jsonb;
  v_max integer;
begin
  select * into strict v_room from party_private.rooms as r
    where r.id = p_room for share;
  v_max := case when v_room.game = 'words' then 20 else 120 end;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'finished', p.finished_at is not null,
    'score', case when p_host or v_room.status = 'revealed' or p.id = p_self
      then p.score else null end,
    'max_score', v_max,
    'time_ms', case when p_host or v_room.status = 'revealed' or p.id = p_self
      then p.time_ms else null end
  ) order by
    case when v_room.status = 'revealed' then p.finished_at is null else false end,
    case when v_room.status = 'revealed' then p.time_ms else null end nulls last,
    p.joined_at, p.id
  ), '[]'::jsonb) into v_players
  from party_private.players as p where p.room_id = v_room.id;

  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'score', p.score, 'max_score', v_max,
    'finished', p.finished_at is not null, 'time_ms', p.time_ms
  ) into v_self from party_private.players as p
  where p.room_id = v_room.id and p.id = p_self;

  return jsonb_build_object(
    'id', v_room.id, 'code', v_room.code, 'game', v_room.game,
    'status', v_room.status, 'created_at', v_room.created_at,
    'starts_at', v_room.starts_at, 'revealed_at', v_room.revealed_at,
    'server_now', clock_timestamp(), 'players', v_players, 'self', v_self
  );
end;
$$;

create function public.party_host_create(p_game text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_host uuid := party_private.require_host();
  v_room uuid;
  v_code text;
  v_bytes bytea;
  v_attempt integer;
  v_i integer;
begin
  if p_game is null or p_game not in ('words', 'jigsaw') then
    raise exception 'Choose Word Scramble or Picture Puzzles.' using errcode = '22023';
  end if;
  for v_attempt in 1..20 loop
    v_bytes := extensions.gen_random_bytes(6);
    v_code := '';
    for v_i in 0..5 loop
      v_code := v_code || substr('ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        (get_byte(v_bytes, v_i) % 26) + 1, 1);
    end loop;
    begin
      insert into party_private.rooms(code, host_id, game)
      values (v_code, v_host, p_game) returning id into v_room;
      return party_private.snapshot(v_room, null, true);
    exception when unique_violation then
      -- Retry a random-code collision; a room code is never reused.
      null;
    end;
  end loop;
  raise exception 'Could not generate a game code. Please try again.';
end;
$$;

create function public.party_host_rooms()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_host uuid := party_private.require_host();
  v_room record;
  v_result jsonb := '[]'::jsonb;
begin
  for v_room in select r.id from party_private.rooms as r
    where r.host_id = v_host order by r.created_at desc, r.id limit 50
  loop
    v_result := v_result || jsonb_build_array(
      party_private.snapshot(v_room.id, null, true));
  end loop;
  return v_result;
end;
$$;

create function public.party_host_view(p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_host uuid := party_private.require_host();
  v_room uuid;
begin
  select r.id into v_room from party_private.rooms as r
  where r.code = party_private.clean_code(p_code) and r.host_id = v_host
  for share;
  if v_room is null then
    raise exception 'Game not found for this host.' using errcode = '22023';
  end if;
  return party_private.snapshot(v_room, null, true);
end;
$$;

create function public.party_host_start(p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_host uuid := party_private.require_host();
  v_room party_private.rooms%rowtype;
begin
  select * into v_room from party_private.rooms as r
  where r.code = party_private.clean_code(p_code) and r.host_id = v_host
  for update;
  if not found then
    raise exception 'Game not found for this host.' using errcode = '22023';
  end if;
  if v_room.status = 'revealed' then
    raise exception 'This game has ended. Create a new game code.' using errcode = '22023';
  end if;
  if v_room.status = 'waiting' then
    if not exists (select 1 from party_private.players as p where p.room_id = v_room.id) then
      raise exception 'Wait for at least one player to join before starting.'
        using errcode = '22023';
    end if;
    update party_private.rooms as r set status = 'running',
      starts_at = clock_timestamp() + interval '5 seconds'
      where r.id = v_room.id;
  end if;
  -- Retrying Start returns the original start time.
  return party_private.snapshot(v_room.id, null, true);
end;
$$;

create function public.party_host_reveal(p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_host uuid := party_private.require_host();
  v_room party_private.rooms%rowtype;
  v_now timestamptz;
begin
  select * into v_room from party_private.rooms as r
  where r.code = party_private.clean_code(p_code) and r.host_id = v_host
  for update;
  if not found then
    raise exception 'Game not found for this host.' using errcode = '22023';
  end if;
  v_now := clock_timestamp();
  if v_room.status = 'waiting' or v_now < v_room.starts_at then
    raise exception 'Start the game and wait for the countdown before revealing results.'
      using errcode = '22023';
  end if;
  if v_room.status = 'running' then
    update party_private.rooms as r set status = 'revealed', revealed_at = v_now
      where r.id = v_room.id;
  end if;
  -- Unfinished players remain listed, below every finisher, with no finish time.
  return party_private.snapshot(v_room.id, null, true);
end;
$$;

create function public.party_join(p_code text, p_name text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_room party_private.rooms%rowtype;
  v_name text;
  v_token text;
  v_player uuid;
begin
  if p_name is null or octet_length(p_name) > 512 then
    raise exception 'Enter a player name from 1 to 24 characters.' using errcode = '22023';
  end if;
  v_name := btrim(regexp_replace(p_name, '[[:space:]]+', ' ', 'g'));
  if char_length(v_name) not between 1 and 24 or v_name ~ '[[:cntrl:]]' then
    raise exception 'Enter a player name from 1 to 24 characters.' using errcode = '22023';
  end if;
  select * into v_room from party_private.rooms as r
  where r.code = party_private.clean_code(p_code) for update;
  if not found then
    raise exception 'Game code not found. Please check the code with the host.'
      using errcode = '22023';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'This game has already started. Ask the host for the next game code.'
      using errcode = '22023';
  end if;
  if (select count(*) from party_private.players as p where p.room_id = v_room.id) >= 200 then
    raise exception 'This game already has 200 players.' using errcode = '22023';
  end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into party_private.players(room_id, name, token_hash)
    values (v_room.id, v_name, extensions.digest(v_token, 'sha256'))
    returning id into v_player;
  return jsonb_build_object('token', v_token,
    'room', party_private.snapshot(v_room.id, v_player, false));
end;
$$;

create function public.party_view(p_code text, p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_room uuid;
  v_player uuid;
begin
  select r.id into v_room from party_private.rooms as r
    where r.code = party_private.clean_code(p_code) for share;
  if v_room is null then
    raise exception 'Game not found.' using errcode = '22023';
  end if;
  v_player := party_private.member_id(v_room, p_token);
  return party_private.snapshot(v_room, v_player, false);
end;
$$;

create function public.party_progress(p_code text, p_token text, p_score integer)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_room party_private.rooms%rowtype;
  v_player party_private.players%rowtype;
  v_player_id uuid;
  v_max integer;
  v_now timestamptz;
begin
  select * into v_room from party_private.rooms as r
    where r.code = party_private.clean_code(p_code) for update;
  if not found then
    raise exception 'Game not found.' using errcode = '22023';
  end if;
  v_player_id := party_private.member_id(v_room.id, p_token);
  select * into strict v_player from party_private.players as p
    where p.id = v_player_id for update;
  v_now := clock_timestamp();
  if v_room.status <> 'running' or v_now < v_room.starts_at then
    raise exception 'Progress can only be saved after the host starts the game and before results are revealed.'
      using errcode = '22023';
  end if;
  if v_player.finished_at is not null then
    raise exception 'Your result has already been submitted.' using errcode = '22023';
  end if;
  v_max := case when v_room.game = 'words' then 20 else 120 end;
  if p_score is null or p_score < 0 or p_score > v_max then
    raise exception 'Score is outside the allowed range.' using errcode = '22023';
  end if;
  update party_private.players as p set score = greatest(p.score, p_score)
    where p.id = v_player.id returning score into v_player.score;
  return jsonb_build_object('score', v_player.score, 'server_now', clock_timestamp());
end;
$$;

create function public.party_finish(p_code text, p_token text, p_score integer)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_room party_private.rooms%rowtype;
  v_player party_private.players%rowtype;
  v_player_id uuid;
  v_max integer;
  v_now timestamptz;
begin
  select * into v_room from party_private.rooms as r
    where r.code = party_private.clean_code(p_code) for update;
  if not found then
    raise exception 'Game not found.' using errcode = '22023';
  end if;
  v_player_id := party_private.member_id(v_room.id, p_token);
  select * into strict v_player from party_private.players as p
    where p.id = v_player_id for update;
  if v_player.finished_at is not null then
    -- A retry, including one after Reveal, cannot change score or elapsed time.
    return party_private.snapshot(v_room.id, v_player.id, false);
  end if;
  v_now := clock_timestamp();
  if v_room.status <> 'running' or v_now < v_room.starts_at then
    raise exception 'Results can only be submitted after the host starts the game and before the winner is revealed.'
      using errcode = '22023';
  end if;
  v_max := case when v_room.game = 'words' then 20 else 120 end;
  if p_score is null or p_score < 0 or p_score > v_max then
    raise exception 'Score is outside the allowed range.' using errcode = '22023';
  end if;
  update party_private.players as p set
    score = greatest(p.score, p_score),
    finished_at = v_now,
    time_ms = greatest(0, floor(extract(epoch from (v_now - v_room.starts_at)) * 1000)::bigint)
    where p.id = v_player.id;
  return party_private.snapshot(v_room.id, v_player.id, false);
end;
$$;

-- Supabase may grant new public functions to API roles by default. Remove those
-- grants explicitly, then expose exactly the intended RPCs to each role.
revoke all on all functions in schema party_private from public, anon, authenticated;
revoke all on function public.party_host_create(text) from public, anon, authenticated;
revoke all on function public.party_host_rooms() from public, anon, authenticated;
revoke all on function public.party_host_view(text) from public, anon, authenticated;
revoke all on function public.party_host_start(text) from public, anon, authenticated;
revoke all on function public.party_host_reveal(text) from public, anon, authenticated;
revoke all on function public.party_join(text, text) from public, anon, authenticated;
revoke all on function public.party_view(text, text) from public, anon, authenticated;
revoke all on function public.party_progress(text, text, integer) from public, anon, authenticated;
revoke all on function public.party_finish(text, text, integer) from public, anon, authenticated;

grant execute on function public.party_host_create(text) to authenticated;
grant execute on function public.party_host_rooms() to authenticated;
grant execute on function public.party_host_view(text) to authenticated;
grant execute on function public.party_host_start(text) to authenticated;
grant execute on function public.party_host_reveal(text) to authenticated;
grant execute on function public.party_join(text, text) to anon, authenticated;
grant execute on function public.party_view(text, text) to anon, authenticated;
grant execute on function public.party_progress(text, text, integer) to anon, authenticated;
grant execute on function public.party_finish(text, text, integer) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
