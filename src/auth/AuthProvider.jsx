// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// Build the callback URL; include the guest id when we have one
function buildRedirectURL(guestId /* string | null */) {
  const url = new URL(`${window.location.origin}/auth/callback`);
  if (guestId) url.searchParams.set("guest", guestId);
  return url.toString();
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // Ensure we either have an existing session or start an anonymous one
  async function ensureSession() {
    try {
      const { data: sess } = await supabase.auth.getSession();
      if (sess?.session?.user) {
        setUser(sess.session.user);
        return;
      }
      // No session -> start anonymous
      const { data: anonRes, error } = await supabase.auth.signInAnonymously();
      if (error) {
        console.error("Anonymous sign-in failed:", error);
        setUser(null);
        return;
      }
      setUser(anonRes?.user ?? null);
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
  }, []);

  // --------- Email/password: ALWAYS sign up (to trigger "Confirm signup")
  // Then adopt guest data on the callback page.
  async function signupOrLink(email, password) {
    const { data: { user: current } = {} } = await supabase.auth.getUser();

    if (current?.is_anonymous) {
      const oldGuestId = current.id;

      // store locally (same-device)
      localStorage.setItem("guest_to_adopt", oldGuestId);

      // include guest id in the email redirect (cross-device)
      const emailRedirectTo = buildRedirectURL(oldGuestId);

      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo },
      });
      if (error) throw error;

      return { signedUp: true, fallback: true };
    }

    // Non-guest: normal signup
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: buildRedirectURL(null) },
    });
    if (error) throw error;
    return { signedUp: true };
  }

  // --------- Email/password: sign in (normal) ----------
  function signin(email, password) {
    return supabase.auth.signInWithPassword({ email, password });
  }

  // --------- OAuth: sign in OR link to anonymous ----------
  async function oauthOrLink(provider /* 'google' | 'github' | ... */) {
    const { data: { user: current } = {} } = await supabase.auth.getUser();
    const redirectTo = buildRedirectURL(null); // no adoption needed for OAuth link

    if (current?.is_anonymous) {
      // OAuth linking keeps same user.id, so no adopt step required
      const { error } = await supabase.auth.linkIdentity({
        provider,
        options: { redirectTo },
      });
      if (error) throw error;
      return { linked: true };
    } else {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo },
      });
      if (error) throw error;
      return { signedIn: true };
    }
  }

  // --------- Sign out → immediately start a fresh anonymous session ----------
  const signout = async () => {
    setReady(false);
    await supabase.auth.signOut();

    const { data: anonRes, error: anonErr } = await supabase.auth.signInAnonymously();
    if (anonErr) {
      console.error("Failed to start anonymous session after sign out:", anonErr);
    }
    const { data } = await supabase.auth.getUser();
    setUser(data?.user ?? null);
    setReady(true);
  };

  return (
    <AuthCtx.Provider
      value={{
        user,
        ready,
        signupOrLink,   // use for “Create account”
        signin,
        oauthOrLink,    // use for OAuth buttons
        signout,
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
