-- 1. Criar bucket publico para as fotos dos quebra-cabecas
insert into storage.buckets (id, name, public) 
values ('puzzle-images', 'puzzle-images', true)
on conflict (id) do nothing;

-- Politica de acesso ao bucket
do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'Acesso publico puzzle-images'
  ) then
    create policy "Acesso publico puzzle-images"
      on storage.objects for all
      using ( bucket_id = 'puzzle-images' )
      with check ( bucket_id = 'puzzle-images' );
  end if;
end $$;

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

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'puzzles' and policyname = 'Acesso publico puzzles'
  ) then
    create policy "Acesso publico puzzles" on public.puzzles for all using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'found_pieces' and policyname = 'Acesso publico found_pieces'
  ) then
    create policy "Acesso publico found_pieces" on public.found_pieces for all using (true) with check (true);
  end if;
end $$;
