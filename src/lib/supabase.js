

import { createClient } from '@supabase/supabase-js';
const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

console.log('VITE_SUPABASE_URL:', url)
console.log('VITE_SUPABASE_ANON_KEY present:', Boolean(key))

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

if (typeof window !== "undefined") window.sb = supabase; // TEMP for console tests
