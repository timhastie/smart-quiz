// src/lib/supabase.js
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  // Helpful in all browsers
  console.error("[supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY");
}

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Let Supabase process /auth/callback URLs itself so the flow stays consistent across browsers.
    detectSessionInUrl: true,

    // Force a simple, Safari-friendly storage implementation.
    // (Supabase falls back automatically, but we make it explicit.)
    storage: typeof window !== "undefined" ? window.localStorage : undefined,

    // Safari has had BroadcastChannel / multi-tab quirks that can cause
    // hanging getSession() promises. Turn this off for now.
    multiTab: false,

    // Optional but nice for debugging:
    // debug: true,
  },
});

// Debug handle: `window.sb` in DevTools.
if (typeof window !== "undefined") {
  window.sb = supabase;
}
