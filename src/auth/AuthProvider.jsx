// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// Where Supabase should send users back
function buildRedirectURL() {
  try {
    return `${window.location.origin}/auth/callback`;
  } catch {
    return "/auth/callback";
  }
}

function getPathname() {
  try {
    return window.location.pathname || "/";
  } catch {
    return "/";
  }
}

function onAuthCallbackPath() {
  return getPathname().startsWith("/auth/callback");
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // ---- Auth state subscription (single source of truth) ----
  useEffect(() => {
    let mounted = true;

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const uid = session?.user?.id || null;
      console.log("[AuthProvider] onAuthStateChange:", event, "user:", uid);

      if (!mounted) return;

      // session may be null on SIGNED_OUT etc.
      setUser(session?.user ?? null);

      // If we're not on /auth/callback, auth changes mean we're safe to unblock the UI
      if (!onAuthCallbackPath()) {
        setReady(true);
      }
    });

    return () => {
      mounted = false;
      try {
        sub?.subscription?.unsubscribe();
      } catch {}
    };
  }, []);

  // ---- Bootstrap existing session OR create anon (except on /auth/callback) ----
  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      const path = getPathname();
      console.log("[AuthProvider] bootstrap start, path:", path);

      // On /auth/callback we let <AuthCallback /> drive everything.
      if (onAuthCallbackPath()) {
        console.log(
          "[AuthProvider] on /auth/callback -> skip bootstrap (waiting for AuthCallback)"
        );
        return; // DO NOT setReady here; AuthCallback will.
      }

      try {
        // Safari-safe: race getSession() against a timeout so it can't hang forever.
        const timeoutMs = 4000;
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("getSession timeout")), timeoutMs)
        );

        const { data, error } = await Promise.race([
          supabase.auth.getSession(),
          timeout,
        ]);

        if (error) {
          console.warn("[AuthProvider] getSession error:", error);
        } else if (data?.session?.user) {
          console.log(
            "[AuthProvider] bootstrap found existing user:",
            data.session.user.id
          );
          if (mounted) setUser(data.session.user);
          return;
        } else {
          console.log("[AuthProvider] bootstrap: no existing session");
        }
      } catch (e) {
        console.warn("[AuthProvider] getSession failed/timeout:", e?.message || e);
      }

      // If we reach here: no usable session. Start anonymous session.
      try {
        const { data: anonRes, error: anonErr } =
          await supabase.auth.signInAnonymously();
        if (anonErr) {
          console.error("[AuthProvider] anonymous sign-in failed:", anonErr);
          if (mounted) setUser(null);
        } else {
          console.log(
            "[AuthProvider] started anonymous session:",
            anonRes?.user?.id || null
          );
          if (mounted) setUser(anonRes?.user ?? null);
        }
      } catch (e) {
        console.error("[AuthProvider] anonymous sign-in threw:", e);
        if (mounted) setUser(null);
      } finally {
        if (mounted) setReady(true);
        console.log("[AuthProvider] bootstrap complete");
      }
    }

    bootstrap();

    return () => {
      mounted = false;
    };
  }, []);

  // ---- helper to detect anon users (for adopt_guest) ----
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

  // ---- adopt_guest: once we become a real user, merge previous guest ----
  useEffect(() => {
    if (!ready || !user) return;

    console.log("[AuthProvider] ready+user effect", {
      ready,
      userId: user.id,
    });

    const oldId = localStorage.getItem("guest_to_adopt");
    if (!oldId) return;
    if (isAnonymous(user)) return;

    (async () => {
      console.log("[AuthProvider] adopting guest", oldId, "->", user.id);
      const { error } = await supabase.rpc("adopt_guest", {
        p_old_user: oldId,
      });
      if (!error) {
        console.log("[AuthProvider] adopt_guest success, clearing marker");
        localStorage.removeItem("guest_to_adopt");
      } else {
        console.warn("[AuthProvider] adopt_guest failed:", error);
      }
    })();
  }, [ready, user?.id]);

  // ---- public auth helpers ----

  // Always sign up (email/password)
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
      typeof window !== "undefined" ? buildRedirectURL() : undefined;

    console.log("[AuthProvider] Starting OAuth", {
      provider,
      redirectTo,
      guestId,
    });

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo },
    });
    if (error) throw error;
    return { started: true };
  }

  const signout = async () => {
    console.log("[AuthProvider] signout called");
    setReady(false);

    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.error("[AuthProvider] signOut error:", e);
    }

    // Start a fresh anonymous session so the app is usable post-logout.
    try {
      const { data: anonRes, error: anonErr } =
        await supabase.auth.signInAnonymously();
      if (anonErr) {
        console.error(
          "[AuthProvider] anon session after signout failed:",
          anonErr
        );
        setUser(null);
      } else {
        console.log(
          "[AuthProvider] anon session after signout:",
          anonRes?.user?.id || null
        );
        setUser(anonRes?.user ?? null);
      }
    } catch (e) {
      console.error("[AuthProvider] anon after signout threw:", e);
      setUser(null);
    } finally {
      setReady(true);
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
