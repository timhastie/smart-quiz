// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// Build the callback URL; include the guest id when we have one
function buildRedirectURL(guestId) {
  const url = new URL(`${window.location.origin}/auth/callback`);
  if (guestId) url.searchParams.set("guest", guestId);
  return url.toString();
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // NEW: don’t bootstrap anon on the callback page
  const isAuthCallback =
    typeof window !== "undefined" &&
    window.location.pathname.startsWith("/auth/callback");

  async function ensureSession() {
    try {
      const { data: sess } = await supabase.auth.getSession();
      if (sess?.session?.user) {
        setUser(sess.session.user);
        return;
      }
      // No session -> start anonymous (but NOT on /auth/callback)
      if (!isAuthCallback) {
        const { data: anonRes, error } = await supabase.auth.signInAnonymously();
        if (error) {
          console.error("Anonymous sign-in failed:", error);
          setUser(null);
          return;
        }
        setUser(anonRes?.user ?? null);
      }
    } finally {
      setReady(true);
    }
  }

  useEffect(() => {
    ensureSession();

    const { data: listener } = supabase.auth.onAuthStateChange((_evt, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      try {
        listener?.subscription?.unsubscribe();
      } catch {}
    };
  }, [isAuthCallback]);

  // --------- Email/password: ALWAYS sign up (to trigger Confirm signup) ----------
  async function signupOrLink(email, password) {
    const { data: { user: current } = {} } = await supabase.auth.getUser();

    if (current?.is_anonymous) {
      const oldGuestId = current.id;
      localStorage.setItem("guest_to_adopt", oldGuestId); // same-device fallback
      const emailRedirectTo = buildRedirectURL(oldGuestId); // cross-device

      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo },
      });
      if (error) throw error;
      return { signedUp: true, fallback: true };
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: buildRedirectURL(null) },
    });
    if (error) throw error;
    return { signedUp: true };
  }

  function signin(email, password) {
    return supabase.auth.signInWithPassword({ email, password });
  }

  async function oauthOrLink(provider) {
    const { data: { user: current } = {} } = await supabase.auth.getUser();
    const redirectTo = buildRedirectURL(null);

    if (current?.is_anonymous) {
      const { error } = await supabase.auth.linkIdentity({ provider, options: { redirectTo } });
      if (error) throw error;
      return { linked: true };
    } else {
      const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo } });
      if (error) throw error;
      return { signedIn: true };
    }
  }

  const signout = async () => {
    setReady(false);
    await supabase.auth.signOut();
    // Optional: keep creating a fresh anon on signout (this is fine)
    const { data: anonRes, error: anonErr } = await supabase.auth.signInAnonymously();
    if (anonErr) console.error("Failed to start anonymous session after sign out:", anonErr);
    const { data } = await supabase.auth.getUser();
    setUser(data?.user ?? null);
    setReady(true);
  };

  return (
    <AuthCtx.Provider value={{ user, ready, signupOrLink, signin, oauthOrLink, signout }}>
      {children}
    </AuthCtx.Provider>
  );
}
