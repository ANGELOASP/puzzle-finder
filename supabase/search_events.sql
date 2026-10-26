-- PuzzleFinder: eventos de busca para medir o acerto real e aprender (aprendizado contínuo).
-- Cada usuário vê e grava só os próprios eventos. Pode rodar mais de uma vez.
create table if not exists public.search_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone default now(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  puzzle_id uuid references public.puzzles(id) on delete cascade,
  mode text not null,
  outcome text not null,
  payload jsonb not null default '{}'::jsonb
);
create index if not exists search_events_user_idx on public.search_events (user_id, created_at desc);
alter table public.search_events enable row level security;
drop policy if exists "Dono gerencia search_events" on public.search_events;
create policy "Dono gerencia search_events" on public.search_events
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
