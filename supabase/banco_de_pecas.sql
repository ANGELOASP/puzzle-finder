-- PuzzleFinder: banco de peças. Guarda as peças já separadas de cada foto (recortes e silhuetas, ~1 MB por foto) para o
-- servidor não separar de novo depois de reiniciar. Cole no SQL Editor e clique em Run. Pode rodar mais de uma vez.
-- Requer supabase/colaboracao.sql (função is_member).
insert into storage.buckets (id, name, public, file_size_limit)
values ('piece-banks', 'piece-banks', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = 20971520;

drop policy if exists "Membros usam piece-banks" on storage.objects;
create policy "Membros usam piece-banks" on storage.objects for all to authenticated
  using (bucket_id = 'piece-banks' and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.is_member(((storage.foldername(name))[1])::uuid) else false end)
  with check (bucket_id = 'piece-banks' and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.is_member(((storage.foldername(name))[1])::uuid) else false end);
