-- CareerConnectSA Supabase starter schema
-- Run in Supabase Dashboard > SQL Editor. This schema protects profile, vacancy,
-- application, and document metadata rows. Existing HTML prototype features still
-- need to be migrated from localStorage before those features become cross-device.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null default '',
  role text not null default 'Job Seeker'
    check (role in ('Grade 12 Learner','TVET Student/Graduate','University Student/Graduate','Job Seeker','Employer/Company')),
  phone text,
  company_name text,
  company_reg_no text,
  qualification_level text,
  field_of_interest text,
  email_alerts boolean not null default true,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  company_verification_status text not null default 'Pending'
    check (company_verification_status in ('Pending','Verified','Rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists qualification_level text;
alter table public.profiles add column if not exists field_of_interest text;
alter table public.profiles add column if not exists email_alerts boolean not null default true;

create or replace function public.handle_new_careerconnect_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_role text := coalesce(new.raw_user_meta_data->>'role', 'Job Seeker');
begin
  if requested_role not in ('Grade 12 Learner','TVET Student/Graduate','University Student/Graduate','Job Seeker','Employer/Company') then
    requested_role := 'Job Seeker';
  end if;
  insert into public.profiles (id, email, full_name, role, phone, company_name, company_reg_no)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    requested_role,
    nullif(new.raw_user_meta_data->>'phone', ''),
    nullif(new.raw_user_meta_data->>'company', ''),
    nullif(new.raw_user_meta_data->>'company_reg_no', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_careerconnect on auth.users;
create trigger on_auth_user_created_careerconnect
after insert on auth.users
for each row execute procedure public.handle_new_careerconnect_user();

-- Prevent clients from upgrading their own role or changing employer verification status.
create or replace function public.protect_careerconnect_profile_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role is distinct from old.role then
    raise exception 'Profile role cannot be changed from the client';
  end if;
  if new.company_verification_status is distinct from old.company_verification_status then
    raise exception 'Company verification status can only be changed by a trusted administrator';
  end if;
  return new;
end;
$$;
drop trigger if exists protect_careerconnect_profile_fields_trigger on public.profiles;
create trigger protect_careerconnect_profile_fields_trigger
before update on public.profiles
for each row execute procedure public.protect_careerconnect_profile_fields();

create table if not exists public.vacancies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  company_name text not null default '',
  title text not null,
  field text,
  location text not null default '',
  description text not null default '',
  is_closed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vacancies add column if not exists company_name text not null default '';

create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  vacancy_id uuid not null references public.vacancies(id) on delete cascade,
  candidate_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'Pending' check (status in ('Pending','Reviewed','Shortlisted','Accepted','Declined')),
  feedback text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vacancy_id, candidate_id)
);

-- Metadata only. Store uploaded files in a private Storage bucket, not in this table.
create table if not exists public.user_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  document_type text not null default 'other',
  created_at timestamptz not null default now(),
  unique (user_id, storage_path)
);

alter table public.profiles enable row level security;
alter table public.vacancies enable row level security;
alter table public.applications enable row level security;
alter table public.user_documents enable row level security;

-- Profiles: a signed-in user may read and update their own non-role profile fields.
drop policy if exists "profile_select_self" on public.profiles;
create policy "profile_select_self" on public.profiles
for select to authenticated using (id = (select auth.uid()));
drop policy if exists "profile_update_self" on public.profiles;
create policy "profile_update_self" on public.profiles
for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
drop policy if exists "employer_read_applicant_profiles" on public.profiles;
create policy "employer_read_applicant_profiles" on public.profiles
for select to authenticated using (
  exists (
    select 1 from public.applications a
    join public.vacancies v on v.id = a.vacancy_id
    where a.candidate_id = profiles.id and v.owner_id = (select auth.uid())
  )
);

-- Vacancy feed: authenticated candidates can read open vacancies; employers can read/manage their own.
drop policy if exists "vacancy_read_open_or_owned" on public.vacancies;
create policy "vacancy_read_open_or_owned" on public.vacancies
for select to authenticated using (
  (is_closed = false and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role <> 'Employer/Company'))
  or owner_id = (select auth.uid())
);
drop policy if exists "employer_create_vacancy" on public.vacancies;
create policy "employer_create_vacancy" on public.vacancies
for insert to authenticated with check (
  owner_id = (select auth.uid())
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'Employer/Company' and p.company_verification_status = 'Verified')
);
drop policy if exists "employer_update_own_vacancy" on public.vacancies;
create policy "employer_update_own_vacancy" on public.vacancies
for update to authenticated using (
  owner_id = (select auth.uid()) and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'Employer/Company' and p.company_verification_status = 'Verified')
) with check (owner_id = (select auth.uid()));
drop policy if exists "employer_delete_own_vacancy" on public.vacancies;
create policy "employer_delete_own_vacancy" on public.vacancies
for delete to authenticated using (owner_id = (select auth.uid()));

-- Applications: candidates can create/read their own; owners of the vacancy can review/update them.
drop policy if exists "candidate_read_own_applications" on public.applications;
create policy "candidate_read_own_applications" on public.applications
for select to authenticated using (
  candidate_id = (select auth.uid()) or exists (select 1 from public.vacancies v where v.id = vacancy_id and v.owner_id = (select auth.uid()) )
);
drop policy if exists "candidate_apply_to_open_vacancy" on public.applications;
create policy "candidate_apply_to_open_vacancy" on public.applications
for insert to authenticated with check (
  candidate_id = (select auth.uid())
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role <> 'Employer/Company')
  and exists (select 1 from public.vacancies v where v.id = vacancy_id and v.is_closed = false)
);
drop policy if exists "employer_update_applications" on public.applications;
create policy "employer_update_applications" on public.applications
for update to authenticated using (
  exists (select 1 from public.vacancies v where v.id = vacancy_id and v.owner_id = (select auth.uid()))
) with check (
  exists (select 1 from public.vacancies v where v.id = vacancy_id and v.owner_id = (select auth.uid()))
);

-- Candidate documents: only the owner can view or change their metadata.
drop policy if exists "documents_owner_all" on public.user_documents;
create policy "documents_owner_all" on public.user_documents
for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Useful indexes
create index if not exists vacancies_open_created_idx on public.vacancies (is_closed, created_at desc);
create index if not exists vacancies_owner_idx on public.vacancies (owner_id);
create index if not exists applications_candidate_idx on public.applications (candidate_id, created_at desc);
create index if not exists applications_vacancy_idx on public.applications (vacancy_id, created_at desc);
create index if not exists user_documents_owner_idx on public.user_documents (user_id, created_at desc);

-- Note: only trusted server-side/admin tooling should mark company_verification_status='Verified'.
-- Do not expose service_role/secret keys in the website.


-- Private Storage for candidate CVs and qualification documents.
insert into storage.buckets (id, name, public)
values ('careerconnect-documents', 'careerconnect-documents', false)
on conflict (id) do update set public = false;

drop policy if exists "careerconnect_docs_insert_own_folder" on storage.objects;
create policy "careerconnect_docs_insert_own_folder" on storage.objects
for insert to authenticated with check (
  bucket_id = 'careerconnect-documents'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
drop policy if exists "careerconnect_docs_read_own_folder" on storage.objects;
create policy "careerconnect_docs_read_own_folder" on storage.objects
for select to authenticated using (
  bucket_id = 'careerconnect-documents'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
drop policy if exists "careerconnect_docs_delete_own_folder" on storage.objects;
create policy "careerconnect_docs_delete_own_folder" on storage.objects
for delete to authenticated using (
  bucket_id = 'careerconnect-documents'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
