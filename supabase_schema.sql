-- PuzzleFinder: cada usuario logado (Supabase Auth) ve e cadastra so os proprios dados.
-- Pode ser rodado mais de uma vez: cria o que falta e troca as politicas antigas.

-- 1. Bucket PRIVADO para as fotos das caixas. Cada usuario grava em "<user_id>/arquivo.jpg".
insert into storage.buckets (id, name, public)
values ('puzzle-images', 'puzzle-images', false)
on conflict (id) do update set public = false;

-- 2. Tabela de Quebra-Cabecas
create table if not exists public.puzzles (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone default now(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  total_pieces integer default 1000,
  box_image_path text,
  box_image_url text,
  status text default 'em_andamento'
);

-- 3. Tabela de Pecas Encontradas
create table if not exists public.found_pieces (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone default now(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  puzzle_id uuid references public.puzzles(id) on delete cascade,
  piece_number integer,
  rotation_deg integer,
  shape_similarity numeric
);

-- 3.1 Bancos criados antes do login: adiciona as colunas novas.
-- Linhas antigas sem dono ficam invisiveis ate receberem um user_id (ver fim do arquivo).
alter table public.puzzles add column if not exists user_id uuid default auth.uid() references auth.users(id) on delete cascade;
alter table public.puzzles add column if not exists box_image_path text;
alter table public.puzzles alter column box_image_url drop not null;
alter table public.found_pieces add column if not exists user_id uuid default auth.uid() references auth.users(id) on delete cascade;

-- Fotos antigas eram URLs publicas: guarda o caminho dentro do bucket
update public.puzzles
set box_image_path = regexp_replace(box_image_url, '^.*/object/public/puzzle-images/', '')
where box_image_path is null and box_image_url like '%/object/public/puzzle-images/%';

create index if not exists puzzles_user_id_idx on public.puzzles (user_id);
create index if not exists found_pieces_user_id_idx on public.found_pieces (user_id);
create index if not exists found_pieces_puzzle_id_idx on public.found_pieces (puzzle_id);

-- 4. RLS: so usuarios logados, e cada um so com o que e seu
alter table public.puzzles enable row level security;
alter table public.found_pieces enable row level security;

drop policy if exists "Acesso publico puzzles" on public.puzzles;
drop policy if exists "Leitura publica puzzles" on public.puzzles;
drop policy if exists "Cadastro publico puzzles" on public.puzzles;
drop policy if exists "Dono gerencia puzzles" on public.puzzles;
create policy "Dono gerencia puzzles" on public.puzzles
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Acesso publico found_pieces" on public.found_pieces;
drop policy if exists "Leitura publica found_pieces" on public.found_pieces;
drop policy if exists "Registro publico found_pieces" on public.found_pieces;
drop policy if exists "Dono gerencia found_pieces" on public.found_pieces;
create policy "Dono gerencia found_pieces" on public.found_pieces
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.puzzles p where p.id = puzzle_id and p.user_id = (select auth.uid()))
  );

-- 5. Storage: grava na propria pasta; le a propria pasta ou fotos antigas dos proprios quebra-cabecas
drop policy if exists "Acesso publico puzzle-images" on storage.objects;
drop policy if exists "Leitura publica puzzle-images" on storage.objects;
drop policy if exists "Envio publico puzzle-images" on storage.objects;
drop policy if exists "Dono le puzzle-images" on storage.objects;
drop policy if exists "Dono envia puzzle-images" on storage.objects;
drop policy if exists "Dono apaga puzzle-images" on storage.objects;
create policy "Dono le puzzle-images" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'puzzle-images'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or exists (select 1 from public.puzzles p where p.box_image_path = name and p.user_id = (select auth.uid()))
    )
  );
create policy "Dono envia puzzle-images" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'puzzle-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Dono apaga puzzle-images" on storage.objects
  for delete to authenticated
  using (bucket_id = 'puzzle-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 6. Dados criados antes do login (sem dono): atribua a uma conta trocando o e-mail abaixo.
-- update public.puzzles set user_id = (select id from auth.users where email = 'voce@exemplo.com') where user_id is null;
-- update public.found_pieces f set user_id = p.user_id from public.puzzles p where f.puzzle_id = p.id and f.user_id is null;
