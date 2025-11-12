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

  // Bootstrap session, but do NOT auto-create anon on the callback route
  useEffect(() => {
    let mounted = true;

    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!mounted) return;

      if (!data?.user && !onAuthCallbackPath()) {
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
   * OAuth (Google default).
   * IMPORTANT: If a guest session exists, Supabase would try to LINK.
   * To avoid "identity already linked to another user", we:
   *  1) remember the guest id
   *  2) sign out the guest (clears session)
   *  3) start a normal OAuth sign-in
   * /auth/callback will adopt the remembered guest id.
   */
  async function oauthOrLink(provider = "google", opts = {}) {
    console.info("[Auth] oauthOrLink() called — this uses linkIdentity first!");
    const curUser = (await supabase.auth.getUser()).data?.user;
    const isGuest = isAnonUser(curUser);

    const redirectTo = buildRedirectURL("/auth/callback", {
      guest: isGuest ? "1" : "",
      provider,
    });

    if (isGuest) {
      try {
        // persist the guest id so callback can adopt it
        localStorage.setItem("pending_guest_id", curUser.id);
      } catch {}
      // kill the guest session so OAuth becomes a *sign-in*, not a link
      await supabase.auth.signOut();
    }

    await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
        queryParams: { prompt: "select_account" },
        ...opts?.options,
      },
    });
  }

  async function googleSignIn() {
    console.info("[Auth] googleSignIn() → signOut guest + signInWithOAuth");
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
