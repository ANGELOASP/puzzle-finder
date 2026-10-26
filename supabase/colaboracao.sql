-- PuzzleFinder: vários logins no mesmo quebra-cabeça, convite por link e fotos sincronizadas entre aparelhos.
-- Cole tudo no SQL Editor do projeto e clique em Run. Pode rodar mais de uma vez. Não apaga nem altera dados existentes.
begin;

-- 1. Participantes e convites
create table if not exists public.puzzle_members (
  puzzle_id uuid not null references public.puzzles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  created_at timestamp with time zone default now(),
  primary key (puzzle_id, user_id)
);
create table if not exists public.puzzle_invites (
  token text primary key default encode(gen_random_bytes(16), 'hex'),
  puzzle_id uuid not null references public.puzzles(id) on delete cascade,
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamp with time zone default now(),
  expires_at timestamp with time zone default now() + interval '7 days',
  revoked boolean not null default false
);

-- 2. "É dono ou participante?" (security definer: evita recursão nas políticas)
create or replace function public.is_member(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.puzzles p where p.id = pid and p.user_id = auth.uid())
      or exists (select 1 from public.puzzle_members m where m.puzzle_id = pid and m.user_id = auth.uid());
$$;

alter table public.puzzle_members enable row level security;
alter table public.puzzle_invites enable row level security;

drop policy if exists "Membros veem participantes" on public.puzzle_members;
create policy "Membros veem participantes" on public.puzzle_members for select to authenticated using (public.is_member(puzzle_id));
drop policy if exists "Dono remove participantes" on public.puzzle_members;
create policy "Dono remove participantes" on public.puzzle_members for delete to authenticated
  using (exists (select 1 from public.puzzles p where p.id = puzzle_id and p.user_id = auth.uid()) or user_id = auth.uid());

drop policy if exists "Membros veem convites" on public.puzzle_invites;
create policy "Membros veem convites" on public.puzzle_invites for select to authenticated using (public.is_member(puzzle_id));
drop policy if exists "Membros criam convites" on public.puzzle_invites;
create policy "Membros criam convites" on public.puzzle_invites for insert to authenticated
  with check (public.is_member(puzzle_id) and created_by = auth.uid());
drop policy if exists "Membros revogam convites" on public.puzzle_invites;
create policy "Membros revogam convites" on public.puzzle_invites for update to authenticated using (public.is_member(puzzle_id));

-- 3. Entrar pelo link: valida o convite e vira participante. Devolve o id do quebra-cabeça.
create or replace function public.accept_invite(p_token text) returns uuid
language plpgsql security definer set search_path = public as $$
declare inv public.puzzle_invites;
begin
  if auth.uid() is null then raise exception 'login necessário'; end if;
  select * into inv from public.puzzle_invites where token = p_token and not revoked and expires_at > now();
  if not found then raise exception 'convite inválido ou vencido'; end if;
  insert into public.puzzle_members (puzzle_id, user_id, email)
  values (inv.puzzle_id, auth.uid(), auth.jwt() ->> 'email')
  on conflict (puzzle_id, user_id) do nothing;
  return inv.puzzle_id;
end $$;
grant execute on function public.accept_invite(text) to authenticated;

-- 4. Participantes enxergam e usam o quebra-cabeça (o dono continua com as políticas que já tinha)
drop policy if exists "Membros veem puzzles" on public.puzzles;
create policy "Membros veem puzzles" on public.puzzles for select to authenticated using (public.is_member(id));
drop policy if exists "Membros atualizam puzzles" on public.puzzles;
create policy "Membros atualizam puzzles" on public.puzzles for update to authenticated using (public.is_member(id)) with check (public.is_member(id));
drop policy if exists "Membros gerenciam found_pieces" on public.found_pieces;
create policy "Membros gerenciam found_pieces" on public.found_pieces for all to authenticated
  using (public.is_member(puzzle_id)) with check (public.is_member(puzzle_id));

-- Foto da caixa: participantes leem o arquivo do dono
drop policy if exists "Membros leem puzzle-images" on storage.objects;
create policy "Membros leem puzzle-images" on storage.objects for select to authenticated
  using (bucket_id = 'puzzle-images' and exists (select 1 from public.puzzles p where p.box_image_path = name and public.is_member(p.id)));

-- 5. Marcar uma peça como montada/faltando sem sobrescrever o que outra pessoa marcou ao mesmo tempo
create or replace function public.set_cell(p_puzzle uuid, p_index int, p_value text) returns text
language plpgsql security definer set search_path = public as $$
declare p public.puzzles; m text;
begin
  if not public.is_member(p_puzzle) then raise exception 'sem acesso'; end if;
  if p_value not in ('0', '1', '?') then raise exception 'valor inválido'; end if;
  select * into p from public.puzzles where id = p_puzzle for update;
  if p.cols is null or p_index < 0 or p_index >= p.cols * p.rows then raise exception 'célula inválida'; end if;
  m := coalesce(p.scan_map, repeat('?', p.cols * p.rows));
  m := overlay(m placing p_value from p_index + 1 for 1);
  update public.puzzles set scan_map = m where id = p_puzzle;
  return m;
end $$;
grant execute on function public.set_cell(uuid, int, text) to authenticated;

-- 6. Fotos das peças sincronizadas entre aparelhos (tirou no celular, aparece no desktop)
create table if not exists public.puzzle_photos (
  id text primary key,
  puzzle_id uuid not null references public.puzzles(id) on delete cascade,
  uploaded_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  path text not null,
  done boolean not null default false,
  confirmed jsonb not null default '[]'::jsonb,
  user_count integer,
  count_ok boolean not null default false,
  deleted boolean not null default false
);
create index if not exists puzzle_photos_puzzle_idx on public.puzzle_photos (puzzle_id, created_at);
alter table public.puzzle_photos enable row level security;
drop policy if exists "Membros gerenciam fotos" on public.puzzle_photos;
create policy "Membros gerenciam fotos" on public.puzzle_photos for all to authenticated
  using (public.is_member(puzzle_id)) with check (public.is_member(puzzle_id));

insert into storage.buckets (id, name, public) values ('puzzle-photos', 'puzzle-photos', false) on conflict (id) do nothing;
drop policy if exists "Membros usam puzzle-photos" on storage.objects;
create policy "Membros usam puzzle-photos" on storage.objects for all to authenticated
  using (bucket_id = 'puzzle-photos' and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.is_member(((storage.foldername(name))[1])::uuid) else false end)
  with check (bucket_id = 'puzzle-photos' and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.is_member(((storage.foldername(name))[1])::uuid) else false end);

commit;
