-- Mirror of nooksweb migration.
alter table public.push_subscriptions
  add column if not exists app_language text check (app_language in ('en', 'ar'));
