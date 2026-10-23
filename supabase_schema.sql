-- 1. Criar bucket publico para as fotos dos quebra-cabecas
insert into storage.buckets (id, name, public) 
values ('puzzle-images', 'puzzle-images', true)
on conflict (id) do nothing;

-- Politica de acesso ao bucket: o app so le (URL publica) e envia fotos novas.
-- Sem UPDATE/DELETE, ninguem com a anon key consegue apagar ou trocar fotos de outros.
drop policy if exists "Acesso publico puzzle-images" on storage.objects;
drop policy if exists "Leitura publica puzzle-images" on storage.objects;
drop policy if exists "Envio publico puzzle-images" on storage.objects;
create policy "Leitura publica puzzle-images" on storage.objects
  for select using ( bucket_id = 'puzzle-images' );
create policy "Envio publico puzzle-images" on storage.objects
  for insert with check ( bucket_id = 'puzzle-images' );

-- 2. Tabela de Quebra-Cabecas
create table if not exists public.puzzles (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone default now(),
  name text not null,
  total_pieces integer default 1000,
  box_image_url text not null,
  status text default 'em_andamento'
);

-- 3. Tabela de Pecas Encontradas
create table if not exists public.found_pieces (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone default now(),
  puzzle_id uuid references public.puzzles(id) on delete cascade,
  piece_number integer,
  rotation_deg integer,
  shape_similarity numeric
);

-- Habilitar RLS e politicas publicas
alter table public.puzzles enable row level security;
alter table public.found_pieces enable row level security;

-- O app so lista e cadastra (quebra-cabecas e pecas encontradas): sem UPDATE/DELETE publicos.
-- Rodar este arquivo de novo troca as politicas antigas "for all" pelas restritas.
drop policy if exists "Acesso publico puzzles" on public.puzzles;
drop policy if exists "Leitura publica puzzles" on public.puzzles;
drop policy if exists "Cadastro publico puzzles" on public.puzzles;
create policy "Leitura publica puzzles" on public.puzzles for select using (true);
create policy "Cadastro publico puzzles" on public.puzzles for insert with check (true);

drop policy if exists "Acesso publico found_pieces" on public.found_pieces;
drop policy if exists "Leitura publica found_pieces" on public.found_pieces;
drop policy if exists "Registro publico found_pieces" on public.found_pieces;
create policy "Leitura publica found_pieces" on public.found_pieces for select using (true);
create policy "Registro publico found_pieces" on public.found_pieces for insert with check (true);
