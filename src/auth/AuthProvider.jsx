// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

/** Helpers */
function onAuthCallbackPath() {
  if (typeof window === "undefined") return false;
  return window.location.pathname.startsWith("/auth/callback");
}
function redirectToCallback() {
  if (typeof window === "undefined") return undefined;
  return new URL("/auth/callback", window.location.origin).toString();
}

const AuthCtx = createContext(null);
export function useAuth() {
  return useContext(AuthCtx);
}

export default function AuthProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      // 1) Bootstrap current session
      const { data } = await supabase.auth.getUser();
      if (!mounted) return;

      // 2) Create anonymous session for first-time visitors,
      //    but NEVER do this on the /auth/callback route.
      if (!data?.user && !onAuthCallbackPath()) {
        await supabase.auth.signInAnonymously();
      }

      const { data: d2 } = await supabase.auth.getUser();
      if (!mounted) return;
      setUser(d2?.user ?? null);
      setReady(true);
    })();

    // React to auth changes
    const { data: sub } = supabase.auth.onAuthStateChange((_ev, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  // ---------- Email/password ----------
  async function signupOrLink(email, password) {
    // No linking here—do a plain signUp.
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  }

  async function signin(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  async function signout() {
    await supabase.auth.signOut();
  }

  // ---------- Google OAuth (PURE SIGN-IN) ----------
  async function googleSignIn() {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: redirectToCallback(), // NO guest param, NO linkIdentity
      },
    });
  }

  const value = useMemo(
    () => ({
      user,
      ready,
      signupOrLink,
      signin,
      signout,
      googleSignIn,
    }),
    [user, ready]
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
