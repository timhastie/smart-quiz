// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);

// Path helper
function onAuthCallbackPath() {
  // keep this in sync with your router path for the callback page
  return window.location.pathname.startsWith("/auth/callback");
}

// LocalStorage keys
const LS_GUEST_ID = "guest_id_before_oauth";

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

  // Google OAuth (or any provider)
  async function oauthOrLink(provider) {
    // Record the current (guest) user id so we can adopt data after OAuth
    const current = (await supabase.auth.getUser()).data.user;
    if (current?.id) {
      try {
        localStorage.setItem(LS_GUEST_ID, current.id);
      } catch {}
    }

    const redirectTo = `${window.location.origin}/auth/callback`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
        queryParams: {
          // optional UX polish
          access_type: "online",
          prompt: "select_account",
        },
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
    // Immediately recreate anonymous session (outside callback path)
    if (!onAuthCallbackPath()) {
      await supabase.auth.signInAnonymously();
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);
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
