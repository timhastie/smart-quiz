// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);

const LS_GUEST_ID = "guest_id_before_oauth";
const onAuthCallbackPath = () =>
  window.location.pathname.startsWith("/auth/callback");

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // --- central: ensure we actually HAVE a session (creates anon if needed)
  async function ensureSession(reason = "unknown") {
    console.log("[ensureSession] reason:", reason);
    let { data: s } = await supabase.auth.getSession();

    if (!s.session && !onAuthCallbackPath()) {
      // create anon and wait until it’s truly available
      console.log("[ensureSession] no session -> signInAnonymously()");
      await supabase.auth.signInAnonymously();

      // wait loop until a session exists (tight, but bounded)
      const started = Date.now();
      while (true) {
        const { data: s2 } = await supabase.auth.getSession();
        if (s2.session?.user?.id) {
          s = s2;
          break;
        }
        if (Date.now() - started > 2500) {
          console.warn("[ensureSession] timed out waiting for anon session");
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    if (s?.session?.user?.id) {
      setSession(s.session);
      setUser(s.session.user);
    }
    return s?.session ?? null;
  }

  useEffect(() => {
    let unsub;
    (async () => {
      console.log("[AuthBoot] start");
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);
      console.log("[AuthBoot] initial session:", data.session);
      console.log("[AuthBoot] initial user:", data.session?.user);

      unsub = supabase.auth.onAuthStateChange((event, newSession) => {
        console.log("[AuthStateChange]", { event, newSession });
        setSession(newSession ?? null);
        setUser(newSession?.user ?? null);
      }).data.subscription;

      // block app until we’re sure the token exists (unless we’re on callback)
      if (!onAuthCallbackPath()) {
        await ensureSession("boot");
      } else {
        console.log("[AuthBoot] on /auth/callback -> skip anon bootstrap");
      }

      setReady(true);
    })();

    return () => unsub?.unsubscribe();
  }, []);

  // --- Google OAuth as sign-in (not link)
  async function oauthOrLink(provider) {
    const current = (await supabase.auth.getUser()).data.user;
    const currentId = current?.id ?? null;

    // remember the guest we want to adopt later
    if (currentId) {
      try {
        localStorage.setItem(LS_GUEST_ID, currentId);
        console.log("[oauthOrLink] stored guest id:", currentId);
      } catch (e) {
        console.warn("[oauthOrLink] LS set failed:", e);
      }
    }

    // sign out locally first to avoid identity linking
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
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error };
    return { user: data.user };
  }

  async function signup(email, password) {
    const current = (await supabase.auth.getUser()).data.user;
    if (current?.id) {
      try { localStorage.setItem(LS_GUEST_ID, current.id); } catch {}
    }
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { error };
    return { user: data.user };
  }

  async function signout() {
    await supabase.auth.signOut();
    if (!onAuthCallbackPath()) {
      await ensureSession("signout"); // recreate anon and wait
    }
  }

  const value = useMemo(
    () => ({
      ready,
      session,
      user,
      // expose this so callers can await it before hitting protected endpoints
      ensureSession,
      oauthOrLink,
      signin,
      signup,
      signout,
      LS_GUEST_ID,
    }),
    [ready, session, user]
  );

  // Optionally gate rendering until we have a token to prevent early 401s
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
