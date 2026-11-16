-- Leppington Nepalese and Indian Grocery: database setup.
-- Run once in Supabase: Dashboard > SQL Editor > New query > paste > Run.

-- Products, store settings and orders are stored as JSON documents.
create table if not exists public.products (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.settings (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.orders (
  id text primary key,
  data jsonb not null,
  status text not null default 'new',
  created_at timestamptz not null default now()
);
create index if not exists orders_created_idx on public.orders (created_at desc);

-- Staff accounts allowed into the admin.
create table if not exists public.admins (
  user_id uuid primary key references auth.users on delete cascade,
  email text
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

alter table public.products enable row level security;
alter table public.settings enable row level security;
alter table public.orders   enable row level security;
alter table public.admins   enable row level security;

-- Everyone can read products and settings; only staff can change them.
drop policy if exists "products read" on public.products;
create policy "products read" on public.products for select using (true);
drop policy if exists "products write" on public.products;
create policy "products write" on public.products for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "settings read" on public.settings;
create policy "settings read" on public.settings for select using (true);
drop policy if exists "settings write" on public.settings;
create policy "settings write" on public.settings for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Orders are created by the checkout server (which checks prices); only staff can read or update them.
drop policy if exists "orders staff" on public.orders;
create policy "orders staff" on public.orders for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Only needed while the site is on GitHub Pages (no checkout server): lets customers submit new, unpaid orders.
-- Remove it when you move to Cloudflare:  drop policy "orders public insert" on public.orders;
drop policy if exists "orders public insert" on public.orders;
create policy "orders public insert" on public.orders for insert to anon, authenticated
  with check (status = 'new' and coalesce(data->>'paid', 'false') = 'false');

drop policy if exists "admins self" on public.admins;
create policy "admins self" on public.admins for select to authenticated using (user_id = auth.uid());

-- Product photos: public to view, staff to upload or delete.
insert into storage.buckets (id, name, public) values ('product-images', 'product-images', true)
on conflict (id) do nothing;
drop policy if exists "photos staff insert" on storage.objects;
create policy "photos staff insert" on storage.objects for insert to authenticated with check (bucket_id = 'product-images' and public.is_admin());
drop policy if exists "photos staff update" on storage.objects;
create policy "photos staff update" on storage.objects for update to authenticated using (bucket_id = 'product-images' and public.is_admin());
drop policy if exists "photos staff delete" on storage.objects;
create policy "photos staff delete" on storage.objects for delete to authenticated using (bucket_id = 'product-images' and public.is_admin());

-- Live updates: the shop refreshes when products or settings change; staff see new orders instantly.
do $$ begin
  begin alter publication supabase_realtime add table public.products; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.settings; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.orders;   exception when duplicate_object then null; end;
end $$;

-- After creating your staff login (Authentication > Users > Add user), make it an admin:
-- insert into public.admins (user_id, email) select id, email from auth.users where email = 'you@example.com';
