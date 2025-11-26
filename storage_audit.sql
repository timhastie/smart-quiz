-- 🛡️ STORAGE SECURITY CHECK
-- Ensure your file uploads (PDFs, etc.) are private.

-- 1. Enable RLS on storage.objects (Supabase usually does this by default, but good to verify)
alter table storage.objects enable row level security;

-- 2. Policy: Users can only upload to their own folder
-- Assuming you use a bucket named 'documents' and structure like 'user_id/filename'
-- If you haven't set up storage policies yet, this is a good template:

/*
create policy "Users can upload their own files"
on storage.objects for insert
with check (
  bucket_id = 'documents' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

create policy "Users can view their own files"
on storage.objects for select
using (
  bucket_id = 'documents' AND
  auth.uid()::text = (storage.foldername(name))[1]
);
*/

-- NOTE: If you are NOT using Supabase Storage (e.g. only storing text chunks in DB),
-- then you don't need to run this.
