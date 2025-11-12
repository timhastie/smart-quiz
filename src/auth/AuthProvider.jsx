// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);

// Path helper — keep this in sync with your router path for the callback page
function onAuthCallbackPath() {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/auth/callback");
}

// LocalStorage keys
const LS_GUEST_ID = "guest_id_before_oauth";

// Utility: detect anonymous user reliably
function isAnonymousUser(u) {
  if (!u) return false;
  if (u.is_anonymous === true) return true;
  if (u.user_metadata?.is_anonymous === true) return true;
  const prov = u.app_metadata?.provider || null;
  const provs = Array.isArray(u.app_metadata?.providers) ? u.app_metadata.providers : [];
  if (prov === "anonymous" || provs.includes("anonymous")) return true;
  if (Array.isArray(u.identities) && u.identities.some((i) => i?.provider === "anonymous"))
    return true;
  return false;
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // Boot: ensure a session exists (anonymous by default), but never on the OAuth callback route
  useEffect(() => {
    let unsub = null;

    (async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);

      // Subscribe to auth changes
      unsub = supabase.auth.onAuthStateChange((_event, newSession) => {
        setSession(newSession ?? null);
        setUser(newSession?.user ?? null);
      }).data.subscription;

      // Create or reuse an anonymous session unless we’re on the OAuth callback page
      if (!onAuthCallbackPath()) {
        if (!data.session) {
          await supabase.auth.signInAnonymously();
          const { data: s2 } = await supabase.auth.getSession();
          setSession(s2.session ?? null);
          setUser(s2.session?.user ?? null);
        }
      }

      setReady(true);
    })();

    return () => {
      if (unsub) unsub.unsubscribe();
    };
  }, []);

  // Google OAuth (or any provider) — links if current user is anonymous, otherwise signs in
  async function oauthOrLink(provider = "google") {
    try {
      const { data: ures } = await supabase.auth.getUser();
      const me = ures?.user || null;

      // Persist the current (guest) user id so /auth/callback can adopt it
      try {
        if (me?.id) localStorage.setItem(LS_GUEST_ID, me.id);
      } catch {}

      const redirectTo = `${window.location.origin}/auth/callback`;

      const res = isAnonymousUser(me)
        ? await supabase.auth.linkIdentity({ provider, options: { redirectTo } })
        : await supabase.auth.signInWithOAuth({ provider, options: { redirectTo } });

      if (res?.error) throw res.error;
    } catch (e) {
      console.error("[oauthOrLink] failed:", e);
      alert(e?.message || "Sign-in failed. Please try again.");
    }
  }

  async function signin(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error };
    return { user: data.user };
  }

  async function signup(email, password) {
    const { data: ures } = await supabase.auth.getUser();
    const me = ures?.user || null;
    try {
      if (me?.id) localStorage.setItem(LS_GUEST_ID, me.id);
    } catch {}
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { error };
    return { user: data.user };
  }

  async function signout() {
    await supabase.auth.signOut();
    // Immediately recreate anonymous session (outside callback path)
    if (!onAuthCallbackPath()) {
      await supabase.auth.signInAnonymously();
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);
    } else {
      setSession(null);
      setUser(null);
    }
  }

  const value = useMemo(
    () => ({
      ready,
      session,
      user,
      oauthOrLink,
      signin,
      signup,
      signout,
    }),
    [ready, session, user]
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
