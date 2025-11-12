// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

/** Utilities */
function onAuthCallbackPath() {
  if (typeof window === "undefined") return false;
  return window.location.pathname.startsWith("/auth/callback");
}
function buildRedirectURL(path = "/auth/callback", params = {}) {
  const url = new URL(path, window.location.origin);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && `${v}` !== "") url.searchParams.set(k, v);
  });
  return url.toString();
}
function isAnonUser(u) {
  if (!u) return false;
  if (u.is_anonymous) return true;
  if (u.user_metadata?.is_anonymous) return true;
  if (Array.isArray(u.identities)) {
    return u.identities.some((i) => i.provider === "anonymous");
  }
  return false;
}

const AuthCtx = createContext(null);
export function useAuth() {
  return useContext(AuthCtx);
}

export default function AuthProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);

  // Don’t auto-create anon user on the callback route
  useEffect(() => {
    let mounted = true;

    (async () => {
      // Bootstrap session
      const { data } = await supabase.auth.getUser();
      if (!mounted) return;

      if (!data?.user && !onAuthCallbackPath()) {
        // ensure a guest session exists for first-time visitors
        await supabase.auth.signInAnonymously();
        const { data: d2 } = await supabase.auth.getUser();
        if (!mounted) return;
        setUser(d2?.user ?? null);
        setReady(true);
        return;
      }

      setUser(data?.user ?? null);
      setReady(true);
    })();

    // react to auth changes
    const { data: sub } = supabase.auth.onAuthStateChange((_ev, session) => {
      setUser(session?.user ?? null);
    });
    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  /** Email/password */
  async function signupOrLink(email, password) {
    const u = (await supabase.auth.getUser()).data?.user;
    if (isAnonUser(u)) {
      // upgrade the guest via email/password linking
      const { data, error } = await supabase.auth.linkIdentity({
        provider: "email",
        email,
        password,
      });
      if (error) throw error;
      return data;
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      return data;
    }
  }
  async function signin(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    return data;
  }
  async function signout() {
    await supabase.auth.signOut();
  }

  /**
   * Start OAuth (Google by default). We do NOT call linkIdentity for OAuth
   * because it can redirect immediately and we can't catch the "already linked"
   * case reliably. We rely on /auth/callback to adopt/merge any guest data.
   */
  async function oauthOrLink(provider = "google", opts = {}) {
    const curUser = (await supabase.auth.getUser()).data?.user;
    const redirectTo = buildRedirectURL("/auth/callback", {
      guest: isAnonUser(curUser) ? "1" : "",
      provider,
    });

    await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
        // helps users choose the right Google account:
        queryParams: { prompt: "select_account" },
        ...opts?.options,
      },
    });
  }

  // convenience for UI
  async function googleSignIn() {
    return oauthOrLink("google");
  }

  const value = useMemo(
    () => ({
      user,
      ready,
      signupOrLink,
      signin,
      signout,
      oauthOrLink,
      googleSignIn,
    }),
    [user, ready]
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
