// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// Build the callback URL; must match Supabase & Google allow-lists exactly.
function buildRedirectURL() {
  if (typeof window === "undefined") return "/auth/callback";
  return `${window.location.origin}/auth/callback`;
}

function onAuthCallbackPath() {
  try {
    if (typeof window === "undefined") return false;
    return window.location.pathname.startsWith("/auth/callback");
  } catch {
    return false;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // ---------------------------------------------------------------------------
  // Bootstrap session
  // - Normal routes:
  //     * If session exists -> use it
  //     * Else -> create anonymous session
  // - /auth/callback:
  //     * DO NOT touch session; AuthCallback page will handle it.
  //     * We still subscribe to auth state changes so updates propagate.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let mounted = true;

    async function ensureSession() {
      const path =
        typeof window !== "undefined" ? window.location.pathname : "(no-window)";
      console.log("[AuthProvider] ensureSession start, path:", path);

      // On the callback route, let AuthCallback own the flow.
      if (onAuthCallbackPath()) {
        console.log(
          "[AuthProvider] on /auth/callback → skip bootstrap (waiting for AuthCallback)"
        );
        setReady(true);
        return;
      }

      try {
        const { data: sess, error } = await supabase.auth.getSession();
        console.log("[AuthProvider] getSession:", { sess, error });

        if (mounted && sess?.session?.user) {
          console.log(
            "[AuthProvider] existing session user:",
            sess.session.user.id
          );
          setUser(sess.session.user);
          return;
        }

        // No session → start anonymous
        const { data: anonRes, error: anonErr } =
          await supabase.auth.signInAnonymously();
        if (anonErr) {
          console.error(
            "[AuthProvider] Anonymous sign-in failed:",
            anonErr
          );
          if (mounted) setUser(null);
          return;
        }

        console.log(
          "[AuthProvider] started anonymous session:",
          anonRes?.user?.id
        );
        if (mounted) setUser(anonRes?.user ?? null);
      } finally {
        if (mounted) {
          console.log("[AuthProvider] ensureSession complete");
          setReady(true);
        }
      }
    }

    ensureSession();

    const { data: sub } = supabase.auth.onAuthStateChange((evt, session) => {
      console.log(
        "[AuthProvider] auth state change:",
        evt,
        session?.user?.id || null
      );
      if (mounted) {
        setUser(session?.user ?? null);
      }
    });

    return () => {
      mounted = false;
      try {
        sub?.subscription?.unsubscribe?.();
      } catch {}
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Helper: detect anonymous users robustly
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // One-time adopt_guest after real login (upgrade guest → real user)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !user) return;

    console.log("[AuthProvider] ready+user effect", {
      ready,
      userId: user.id,
    });

    const oldId = localStorage.getItem("guest_to_adopt");
    if (!oldId) return;
    if (isAnonymous(user)) return; // only adopt when we are non-anon

    (async () => {
      console.log("[AuthProvider] adopting guest", oldId);
      const { error } = await supabase.rpc("adopt_guest", {
        p_old_user: oldId,
      });
      if (!error) {
        console.log(
          "[AuthProvider] adopt_guest success, clearing marker"
        );
        localStorage.removeItem("guest_to_adopt");
      } else {
        console.warn("[AuthProvider] adopt_guest failed:", error);
      }
    })();
  }, [ready, user?.id]);

  // ---------------------------------------------------------------------------
  // Email / password: always signUp to trigger confirm email.
  // If current user is anon, store guest id for later adopt.
  // ---------------------------------------------------------------------------
  async function signupOrLink(email, password) {
    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    if (current?.is_anonymous) {
      const oldGuestId = current.id;
      localStorage.setItem("guest_to_adopt", oldGuestId);

      const emailRedirectTo = buildRedirectURL();

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
      options: { emailRedirectTo: buildRedirectURL() },
    });
    if (error) throw error;
    return { signedUp: true };
  }

  function signin(email, password) {
    return supabase.auth.signInWithPassword({ email, password });
  }

  // ---------------------------------------------------------------------------
  // OAuth (Google, etc.) using PKCE / redirect to /auth/callback
  // If current is anon, mark guest_to_adopt for adopt_guest after success.
  // ---------------------------------------------------------------------------
  async function oauthSignIn(provider) {
    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    let guestId = null;
    if (current?.is_anonymous) {
      guestId = current.id;
      localStorage.setItem("guest_to_adopt", guestId);
    }

    const redirectTo = buildRedirectURL();

    console.log("[AuthProvider] Starting OAuth", {
      provider,
      redirectTo,
      guestId,
    });

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
      },
    });

    if (error) {
      console.error("[AuthProvider] signInWithOAuth error:", error);
      throw error;
    }

    // Supabase redirects away; { data } is usually minimal.
    return { started: true, data };
  }

  // ---------------------------------------------------------------------------
  // Sign out → start a fresh anonymous session for normal app flow
  // ---------------------------------------------------------------------------
  const signout = async () => {
    setReady(false);

    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.error("[AuthProvider] signOut error:", e);
    }

    try {
      const { data: anonRes, error: anonErr } =
        await supabase.auth.signInAnonymously();
      if (anonErr) {
        console.error(
          "[AuthProvider] Failed to start anonymous session after sign out:",
          anonErr
        );
      } else {
        console.log(
          "[AuthProvider] new anonymous session after sign out:",
          anonRes?.user?.id
        );
        const { data } = await supabase.auth.getUser();
        setUser(data?.user ?? null);
      }
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
        oauthSignIn,
        signout,
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
