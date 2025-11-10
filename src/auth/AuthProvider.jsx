// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// Our single, canonical callback URL (must match Supabase/Google config)
function getCallbackUrl() {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}/auth/callback`;
}

function isOnCallbackPath() {
  if (typeof window === "undefined") return false;
  return window.location.pathname.startsWith("/auth/callback");
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // ---- Initial bootstrap ----
  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      const path = typeof window !== "undefined" ? window.location.pathname : "";
      console.log("[AuthProvider] bootstrap start, path:", path);

      try {
        // 1) See if we already have a session (e.g. after AuthCallback ran)
        const { data, error } = await supabase.auth.getSession();
        if (!mounted) return;

        if (error) {
          console.error("[AuthProvider] getSession error:", error);
        }

        const existingUser = data?.session?.user || null;
        if (existingUser) {
          console.log("[AuthProvider] existing session user:", existingUser.id);
          setUser(existingUser);
          setReady(true);
          return;
        }

        // 2) No session yet.
        //    If we're currently on /auth/callback, AuthCallback will handle it.
        if (isOnCallbackPath()) {
          console.log(
            "[AuthProvider] on /auth/callback with no session yet → wait for AuthCallback + onAuthStateChange"
          );
          // Don't mark ready yet; AuthCallback will notify SIGNED_IN shortly.
          return;
        }

        // 3) Normal pages with no session → start an anonymous session
        const { data: anonRes, error: anonErr } = await supabase.auth.signInAnonymously();
        if (!mounted) return;

        if (anonErr) {
          console.error("[AuthProvider] anonymous sign-in failed:", anonErr);
          setUser(null);
        } else {
          console.log("[AuthProvider] started anonymous session:", anonRes?.user?.id);
          setUser(anonRes?.user ?? null);
        }

        setReady(true);
      } catch (e) {
        if (!mounted) return;
        console.error("[AuthProvider] bootstrap unexpected error:", e);
        // Even on error, avoid hanging the UI forever.
        setReady(true);
      }
    }

    bootstrap();

    // ---- Auth state listener ----
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;

      const uid = session?.user?.id || null;
      console.log("[AuthProvider] onAuthStateChange:", event, "user=", uid);

      // Always reflect latest user
      setUser(session?.user ?? null);

      // Make sure "ready" is true once we know something definitive.
      // This especially helps Safari / callback races.
      switch (event) {
        case "SIGNED_IN":
        case "SIGNED_OUT":
        case "USER_UPDATED":
        case "TOKEN_REFRESHED":
          if (!ready) {
            console.log("[AuthProvider] marking ready after", event);
          }
          setReady(true);
          break;
        default:
          break;
      }
    });

    return () => {
      mounted = false;
      try {
        sub?.subscription?.unsubscribe();
      } catch (e) {
        console.warn("[AuthProvider] unsubscribe error:", e);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // (We intentionally don't include `ready` in deps to avoid re-subscribing.)

  // ---- Helper: detect anonymous user ----
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

  // ---- One-time guest adoption after real login ----
  useEffect(() => {
    if (!ready || !user) return;

    console.log("[AuthProvider] ready+user effect", {
      ready,
      userId: user.id,
    });

    const oldId = localStorage.getItem("guest_to_adopt");
    if (!oldId) return;
    if (isAnonymous(user)) return; // only adopt once we are a non-anon user

    (async () => {
      console.log("[AuthProvider] adopting guest", oldId);
      const { error } = await supabase.rpc("adopt_guest", { p_old_user: oldId });
      if (!error) {
        console.log("[AuthProvider] adopt_guest success, clearing marker");
        localStorage.removeItem("guest_to_adopt");
      } else {
        console.warn("[AuthProvider] adopt_guest failed:", error);
      }
    })();
  }, [ready, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Email/password signup ----
  async function signupOrLink(email, password) {
    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    const emailRedirectTo = getCallbackUrl();

    if (current?.is_anonymous) {
      const oldGuestId = current.id;
      localStorage.setItem("guest_to_adopt", oldGuestId);

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
      options: { emailRedirectTo },
    });
    if (error) throw error;
    return { signedUp: true };
  }

  function signin(email, password) {
    return supabase.auth.signInWithPassword({ email, password });
  }

  // ---- OAuth sign-in (Google, etc.) ----
  async function oauthSignIn(provider) {
    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    let guestId = null;
    if (current?.is_anonymous) {
      guestId = current.id;
      localStorage.setItem("guest_to_adopt", guestId);
    }

    const redirectTo =
      typeof window !== "undefined" ? getCallbackUrl() : undefined;

    console.log("[AuthProvider] Starting OAuth", {
      provider,
      redirectTo,
      guestId,
    });

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
      },
    });

    if (error) throw error;
    return { started: true };
  }

  // ---- Sign out (with safe anon fallback) ----
  const signout = async () => {
    console.log("[AuthProvider] signout start");
    setReady(false);

    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.error("[AuthProvider] signOut error:", e);
    }

    try {
      // After sign-out, try to start a fresh anon session (except on /auth/callback)
      if (!isOnCallbackPath()) {
        const { data: anonRes, error: anonErr } =
          await supabase.auth.signInAnonymously();
        if (anonErr) {
          console.error(
            "[AuthProvider] anon sign-in after signOut failed:",
            anonErr
          );
          setUser(null);
        } else {
          console.log(
            "[AuthProvider] anon session after signOut:",
            anonRes?.user?.id
          );
          setUser(anonRes?.user ?? null);
        }
      } else {
        setUser(null);
      }
    } finally {
      setReady(true);
      console.log("[AuthProvider] signout complete");
    }
  };

  return (
    <AuthCtx.Provider
      value={{ user, ready, signupOrLink, signin, oauthSignIn, signout }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
