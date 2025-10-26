// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

function getRedirectTo() {
  // Must be allowed in Supabase → Auth → URL Configuration → Redirect URLs
  // e.g. https://smart-quiz.app/auth/callback and http://localhost:5173/auth/callback
  return `${window.location.origin}/auth/callback`;
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

  // --------- Email/password: sign up OR link to anonymous ----------
 async function signupOrLink(email, password) {
  const { data: { user: current } = {} } = await supabase.auth.getUser();
  const emailRedirectTo = getRedirectTo();

  if (current?.is_anonymous) {
    // try preferred path first
    const tryLink = await supabase.auth.linkIdentity({
      provider: "email",
      email,
      password,
      options: { emailRedirectTo },
    });

    if (!tryLink.error) return { linked: true };

    // fallback: create a real account, then adopt guest data
    // store old (guest) id before signUp
    const oldId = current.id;

    const su = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo },
    });
    if (su.error) throw su.error;

    // tell the app which guest id to adopt after the callback sign-in completes
    localStorage.setItem("guest_to_adopt", oldId);
    return { signedUp: true, fallback: true };
  } else {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo },
    });
    if (error) throw error;
    return { signedUp: true };
  }
}


  // --------- Email/password: sign in (normal) ----------
  function signin(email, password) {
    return supabase.auth.signInWithPassword({ email, password });
  }

  // --------- OAuth: sign in OR link to anonymous ----------
  async function oauthOrLink(provider /* 'google' | 'github' | ... */) {
    const { data: { user: current } = {} } = await supabase.auth.getUser();
    const redirectTo = getRedirectTo();

    if (current?.is_anonymous) {
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
        signupOrLink,   // <- use this for your “Create account” button
        signin,
        oauthOrLink,    // <- use this for your OAuth buttons
        signout,
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
