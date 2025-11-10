// src/lib/supabase.js
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

console.log("VITE_SUPABASE_URL:", url);
console.log("VITE_SUPABASE_ANON_KEY present:", Boolean(key));

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false, // 🔴 IMPORTANT: we use AuthCallback.jsx instead
  },
});

if (typeof window !== "undefined") window.sb = supabase;
