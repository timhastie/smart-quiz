// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);

const LS_GUEST_ID = "guest_id_before_oauth";
const onAuthCallbackPath = () =>
  typeof window !== "undefined" &&
  window.location.pathname.startsWith("/auth/callback");

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // ---------- helpers ----------
  async function waitForSession(timeoutMs = 2500) {
    const start = Date.now();
    while (true) {
      const { data } = await supabase.auth.getSession();
      if (data?.session?.user?.id) return data.session;
      if (Date.now() - start > timeoutMs) return null;
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  async function resetToAnonymous(tag = "reset") {
    console.warn(`[Auth] ${tag}: resetting to anonymous`);
    await supabase.auth.signOut();
    const { error: anonErr } = await supabase.auth.signInAnonymously();
    if (anonErr) {
      console.error("[Auth] anon sign-in failed", anonErr);
      return null;
    }
    const s = await waitForSession();
    if (s) {
      setSession(s);
      setUser(s.user);
    }
    return s;
  }

  // --- central: ensure we actually HAVE a valid session (creates anon if needed)
  async function ensureSession(reason = "unknown") {
    console.log("[ensureSession] reason:", reason);

    // If we are on /auth/callback, don’t touch session bootstrap here.
    if (onAuthCallbackPath()) {
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);
      return data.session ?? null;
    }

    // 1) Do we have any session?
    let { data: s } = await supabase.auth.getSession();
    if (!s?.session) {
      console.log("[ensureSession] no session -> anon sign-in");
      return await resetToAnonymous("no-session");
    }

    // 2) Probe the token with /auth/v1/user. If 401/403 or missing user, self-heal.
    const probe = await supabase.auth.getUser();
    const bad =
      probe.error?.status === 401 ||
      probe.error?.status === 403 ||
      !probe.data?.user;

    if (bad) {
      console.warn("[ensureSession] stale/invalid token → self-heal");
      return await resetToAnonymous("stale-token");
    }

    // 3) Looks good; persist state.
    setSession(s.session);
    setUser(s.session.user);
    return s.session;
  }

  // ---------- boot ----------
  useEffect(() => {
    let unsub;
    (async () => {
      console.log("[AuthBoot] start");

      // prime local state with whatever exists
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);
      console.log("[AuthBoot] initial session:", data.session);
      console.log("[AuthBoot] initial user:", data.session?.user);

      // subscribe to changes
      unsub = supabase.auth.onAuthStateChange((event, newSession) => {
        console.log("[AuthStateChange]", { event, newSession });
        setSession(newSession ?? null);
        setUser(newSession?.user ?? null);
      }).data.subscription;

      // self-heal / create anon unless we're on the OAuth callback route
      await ensureSession("boot");
      setReady(true);
    })();

    return () => unsub?.unsubscribe();
  }, []);

  // ---------- sign-in / sign-up / oauth ----------
  async function oauthOrLink(provider) {
    const current = (await supabase.auth.getUser()).data.user;
    const currentId = current?.id ?? null;
    if (currentId) {
      try {
        localStorage.setItem(LS_GUEST_ID, currentId);
        console.log("[oauthOrLink] stored guest id:", currentId);
      } catch (e) {
        console.warn("[oauthOrLink] LS set failed:", e);
      }
    }

    // local sign-out avoids identity linking; the redirect flow will auth afresh
    console.log("[oauthOrLink] signOut(local) before redirect");
    await supabase.auth.signOut({ scope: "local" });

    const redirectTo = `${window.location.origin}/auth/callback`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
        queryParams: { access_type: "online", prompt: "select_account" },
      },
    });
    if (error) throw error;
  }

  async function signin(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) return { error };
    await ensureSession("after-password-signin");
    return { user: data.user };
  }

  async function signup(email, password) {
    const current = (await supabase.auth.getUser()).data.user;
    if (current?.id) {
      try {
        localStorage.setItem(LS_GUEST_ID, current.id);
      } catch {}
    }
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { error };
    return { user: data.user };
  }

  async function signout() {
    await supabase.auth.signOut();
    if (!onAuthCallbackPath()) {
      await resetToAnonymous("signout");
    }
  }

  const value = useMemo(
    () => ({
      ready,
      session,
      user,
      ensureSession, // callers (e.g., Generate button) can await this
      oauthOrLink,
      signin,
      signup,
      signout,
      LS_GUEST_ID,
    }),
    [ready, session, user]
  );

  // Gate UI until we know the token is valid to avoid early 401s
  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center text-slate-100">
        <div className="opacity-80">Loading…</div>
      </div>
    );
  }

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
