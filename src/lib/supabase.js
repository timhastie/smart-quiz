// src/lib/supabase.js
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false, // we handle the callback manually
    flowType: "pkce",          // IMPORTANT: use PKCE/code flow
  },
});

// Optional dev helper:
if (typeof window !== "undefined") window.sb = supabase;
