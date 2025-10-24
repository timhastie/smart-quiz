// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false); // becomes true after we confirm or create a session

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
    // Bootstrap session (existing or anonymous)
    ensureSession();

    // Keep user in sync with any later auth changes
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      setUser(session?.user ?? null);
    });
    return () => {
      try {
        sub.subscription.unsubscribe();
      } catch {}
    };
  }, []);

  // Email/password helpers
  const signup = (email, password) => supabase.auth.signUp({ email, password });
  const signin = (email, password) =>
    supabase.auth.signInWithPassword({ email, password });

  // Sign out AND immediately create a fresh anonymous session
  const signout = async () => {
    // briefly pause readiness so any guards don’t redirect away
    setReady(false);

    await supabase.auth.signOut();

    const { data: anonRes, error: anonErr } = await supabase.auth.signInAnonymously();
    if (anonErr) {
      console.error("Failed to start anonymous session after sign out:", anonErr);
    }

    const { data } = await supabase.auth.getUser();
    setUser(data.user ?? null);
    setReady(true);
  };

  return (
    <AuthCtx.Provider value={{ user, ready, signup, signin, signout }}>
      {children}
    </AuthCtx.Provider>
  );
}
