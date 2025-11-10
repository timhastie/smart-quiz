// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { clearGuestId, readGuestId, storeGuestId } from "./guestStorage";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// Build the callback URL; include the guest id when we have one.
function buildRedirectURL(guestId) {
  if (typeof window === "undefined") return "/auth/callback";
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

// Heuristic: does this user look anonymous?
function isAnonymous(u) {
  if (!u) return false;
  const prov = u.app_metadata?.provider || null;
  const provs = Array.isArray(u.app_metadata?.providers)
    ? u.app_metadata.providers
    : [];
  return (
    u.is_anonymous === true ||
    u.user_metadata?.is_anonymous === true ||
    prov === "anonymous" ||
    provs.includes("anonymous") ||
    (Array.isArray(u.identities) &&
      u.identities.some((i) => i?.provider === "anonymous")) ||
    (!u.email && (provs.length === 0 || provs.includes("anonymous")))
  );
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // ---------------------------------------------------------------------------
  // 1) Bootstrap session
  //    - If there is an existing session, use it.
  //    - Otherwise create an anonymous session (except on /auth/callback).
  // ---------------------------------------------------------------------------
  useEffect(() => {
  let mounted = true;

  async function ensureSession() {
    try {
      const { data: sess, error } = await supabase.auth.getSession();
      if (error) {
        console.error("[Auth] getSession error:", error);
      }

      // If we already have a user session, use it
      if (mounted && sess?.session?.user) {
        setUser(sess.session.user);
        return;
      }

      // ❗ IMPORTANT:
      // Only auto-create an anonymous user if we are NOT on /auth/callback
      if (!onAuthCallbackPath()) {
        console.log("[Auth] No session → creating anonymous user");
        const { data: anonRes, error: anonErr } =
          await supabase.auth.signInAnonymously();
        if (anonErr) {
          console.error("[Auth] Anonymous sign-in failed:", anonErr);
          if (mounted) setUser(null);
          return;
        }
        if (mounted) setUser(anonRes?.user ?? null);
      } else {
        console.log(
          "[Auth] On /auth/callback with no session yet → let AuthCallback handle it"
        );
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
    listener?.subscription?.unsubscribe?.();
  };
}, []);

  // ---------------------------------------------------------------------------
  // 2) One-time adopt after login (fallback when callback didn't have ?guest=)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !user) return;
    if (typeof window === "undefined") return;
    const oldId = readGuestId();
    if (!oldId) return;
    if (isAnonymous(user)) return; // only adopt once we are non-anon

    (async () => {
      try {
        const { error } = await supabase.rpc("adopt_guest", {
          p_old_user: oldId,
        });
        if (error) {
          console.warn("adopt_guest (post-login) failed:", error);
          return;
        }
        clearGuestId();
      } catch (e) {
        console.warn("adopt_guest (post-login) threw:", e);
      }
    })();
  }, [ready, user?.id]);

  // ---------------------------------------------------------------------------
  // 3) Email/password: ALWAYS signUp (so they confirm email)
  //    - When anonymous, store guest id so callback / post-login can adopt.
  // ---------------------------------------------------------------------------
  async function signupOrLink(email, password) {
    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    if (current?.is_anonymous) {
      const oldGuestId = current.id;
      storeGuestId(oldGuestId);
      const emailRedirectTo = buildRedirectURL(oldGuestId);

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

  // ---------------------------------------------------------------------------
  // 4) Google sign-in (guest → real upgrade with quiz adoption)
  // ---------------------------------------------------------------------------
  async function googleSignIn() {
    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    const isGuest = isAnonymous(current);
    const guestId = isGuest ? current?.id ?? null : null;

    if (isGuest && guestId) storeGuestId(guestId);

    const redirectTo = buildRedirectURL(guestId);

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        queryParams: {
          prompt: "select_account",
        },
      },
    });

    if (error) {
      console.error("[Auth] googleSignIn error:", error);
      throw error;
    }

    return { started: true };
  }

  // ---------------------------------------------------------------------------
  // 5) Sign out -> start fresh anonymous session again
  // ---------------------------------------------------------------------------
  const signout = async () => {
    setReady(false);
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.error("signOut error:", e);
    }

    try {
      const { data: anonRes, error: anonErr } =
        await supabase.auth.signInAnonymously();
      if (anonErr) {
        console.error(
          "Failed to start anonymous session after sign out:",
          anonErr
        );
      }
      const { data } = await supabase.auth.getUser();
      setUser(data?.user ?? null);
    } finally {
      setReady(true);
    }
  };

  return (
    <AuthCtx.Provider
      value={{
        user,
        ready,
        signupOrLink,
        signin,
        googleSignIn,
        signout,
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
