// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

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

  // ---------- Auth state subscription ----------
  useEffect(() => {
    let mounted = true;

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const uid = session?.user?.id || null;
      console.log("[AuthProvider] onAuthStateChange:", event, "user:", uid);

      if (!mounted) return;

      setUser(session?.user ?? null);

      // IMPORTANT:
      // Whenever we definitively know the auth state, mark ready.
      // This fixes Safari where we were stuck after /auth/callback.
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        setReady(true);
      } else if (event === "SIGNED_OUT") {
        setReady(true);
      } else if (!session) {
        // For safety: any transition to "no session" should not hang UI.
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

  // ---------- Bootstrap existing session / anon (skip heavy work on /auth/callback) ----------
  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      const path = getPathname();
      console.log("[AuthProvider] bootstrap start, path:", path);

      // On /auth/callback we let AuthCallback+onAuthStateChange handle it.
      if (onAuthCallbackPath()) {
        console.log(
          "[AuthProvider] on /auth/callback -> skip bootstrap (waiting for AuthCallback)"
        );
        return;
      }

      try {
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
          if (mounted) {
            setUser(data.session.user);
            setReady(true);
          }
          return;
        } else {
          console.log("[AuthProvider] bootstrap: no existing session");
        }
      } catch (e) {
        console.warn("[AuthProvider] getSession failed/timeout:", e?.message || e);
      }

      // No session -> start anonymous
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
        if (mounted) {
          setReady(true);
          console.log("[AuthProvider] bootstrap complete");
        }
      }
    }

    bootstrap();
    return () => {
      mounted = false;
    };
  }, []);

  // ---------- helper: isAnonymous ----------
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

  // ---------- adopt_guest once we have a real user ----------
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

  // ---------- public API ----------

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
