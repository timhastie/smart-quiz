// src/lib/supabase.js
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false, // we process /auth/callback manually for reliable Safari support
    multiTab: false,
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
  },
});

// dev helper
if (typeof window !== "undefined") {
  window.sb = supabase;
}
