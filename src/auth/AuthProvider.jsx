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

function onAuthCallbackPath() {
  try {
    return window.location.pathname.startsWith("/auth/callback");
  } catch {
    return false;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // --- bootstrap session (don’t create anon on /auth/callback) ---
  useEffect(() => {
    let mounted = true;

    async function ensureSession() {
      try {
        const { data: sess } = await supabase.auth.getSession();
        if (mounted && sess?.session?.user) {
          setUser(sess.session.user);
          return;
        }
        // No session -> start anonymous (but NOT on /auth/callback)
        if (!onAuthCallbackPath()) {
          const { data: anonRes, error } = await supabase.auth.signInAnonymously();
          if (error) {
            console.error("Anonymous sign-in failed:", error);
            if (mounted) setUser(null);
            return;
          }
          if (mounted) setUser(anonRes?.user ?? null);
        }
      } finally {
        if (mounted) setReady(true);
      }
    }

    ensureSession();

    const { data: listener } = supabase.auth.onAuthStateChange((_evt, session) => {
      if (mounted) setUser(session?.user ?? null);
    });

    return () => {
      mounted = false;
      try {
        listener?.subscription?.unsubscribe();
      } catch {}
    };
  }, []);

  // helper
  function isAnonymous(u) {
    if (!u) return false;
    const prov = u.app_metadata?.provider || null;
    const provs = Array.isArray(u.app_metadata?.providers) ? u.app_metadata.providers : [];
    return (
      u.is_anonymous === true ||
      u.user_metadata?.is_anonymous === true ||
      prov === "anonymous" ||
      provs.includes("anonymous") ||
      (Array.isArray(u.identities) && u.identities.some((i) => i?.provider === "anonymous")) ||
      (!u.email && (provs.length === 0 || provs.includes("anonymous")))
    );
  }

  // One-time adopt if we land as a real user and a guest id is stored locally.
  // This covers cases where the callback didn’t include ?guest=...
  useEffect(() => {
    if (!ready || !user) return;
    const oldId = localStorage.getItem("guest_to_adopt");
    if (!oldId) return;
    if (isAnonymous(user)) return; // only adopt after we are a non-anon user

    (async () => {
      const { error } = await supabase.rpc("adopt_guest", { p_old_user: oldId });
      if (!error) {
        localStorage.removeItem("guest_to_adopt");
      } else {
        console.warn("adopt_guest (post-login) failed:", error);
      }
    })();
  }, [ready, user?.id]);

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
  const oldGuestId = current?.is_anonymous ? current.id : null;
  const redirectTo = buildRedirectURL(oldGuestId); // include guest id for adopt

  if (current?.is_anonymous) {
    // Try link → if identity already exists, fall back to signInWithOAuth
    const { error } = await supabase.auth.linkIdentity({
      provider,
      options: { redirectTo },
    });

    const alreadyLinked =
      error?.code === "identity_already_exists" ||
      (typeof error?.message === "string" &&
        /already\s+exists/i.test(error.message)) ||
      error?.status === 400;

    if (alreadyLinked) {
      if (oldGuestId) localStorage.setItem("guest_to_adopt", oldGuestId);
      const { error: signInErr } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo },
      });
      if (signInErr) throw signInErr;
      return { signedIn: true, adopted: "pending" };
    }

    if (error) throw error;
    return { linked: true };
  }

  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo },
  });
  if (error) throw error;
  return { signedIn: true };
}

  const signout = async () => {
    setReady(false);
    await supabase.auth.signOut();

    // Start fresh anon session (normal app flow)
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