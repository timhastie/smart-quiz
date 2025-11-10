// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// Build the callback URL used for all auth redirects.
// MUST match the entries in:
// - Supabase → Authentication → URL Configuration → Redirect URLs
// - Google Cloud OAuth client → Authorized redirect URIs
function buildRedirectURL() {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}/auth/callback`;
}

function onAuthCallbackPath() {
  if (typeof window === "undefined") return false;
  return window.location.pathname.startsWith("/auth/callback");
}

// Heuristic: is this user an anonymous guest?
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
  // Bootstrap session
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let mounted = true;

    async function ensureSession() {
      const path = typeof window !== "undefined" ? window.location.pathname : "";
      console.log("[AuthProvider] ensureSession start, path:", path);

      // NOTE:
      // When we are on /auth/callback, AuthCallback page is responsible for
      // exchanging the code and establishing the session.
      // We DO NOT create an anonymous session here, or we’ll nuke the code_verifier.
      if (onAuthCallbackPath()) {
        console.log(
          "[AuthProvider] on /auth/callback → skip anon bootstrap (waiting for AuthCallback)"
        );
        // Don't mark ready yet; AuthCallback will finish login and
        // onAuthStateChange below will populate user + ready.
        return;
      }

      try {
        const { data } = await supabase.auth.getSession();
        const sessionUser = data?.session?.user || null;

        if (mounted && sessionUser) {
          console.log(
            "[AuthProvider] found existing session user:",
            sessionUser.id
          );
          setUser(sessionUser);
          setReady(true);
          return;
        }

        // No session → create anonymous (for normal app routes only)
        console.log("[AuthProvider] no session → starting anonymous session");
        const { data: anonRes, error: anonErr } =
          await supabase.auth.signInAnonymously();

        if (anonErr) {
          console.error(
            "[AuthProvider] anonymous sign-in failed:",
            anonErr.message || anonErr
          );
          if (mounted) {
            setUser(null);
            setReady(true); // avoid infinite "loading"
          }
          return;
        }

        if (mounted) {
          console.log(
            "[AuthProvider] started anonymous session:",
            anonRes?.user?.id || null
          );
          setUser(anonRes?.user ?? null);
          setReady(true);
        }
      } catch (e) {
        console.error("[AuthProvider] ensureSession unexpected error:", e);
        if (mounted) {
          setUser(null);
          setReady(true);
        }
      }
    }

    ensureSession();

    // Global auth listener: keeps `user` in sync for all flows
    const { data: listener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        const uid = session?.user?.id || null;
        console.log(
          "[AuthProvider] onAuthStateChange:",
          event,
          uid ? `user=${uid}` : "no user"
        );

        if (!mounted) return;

        setUser(session?.user ?? null);

        // If we were stuck "not ready" (e.g. arriving on /auth/callback),
        // a SIGNED_IN / TOKEN_REFRESHED / USER_UPDATED should flip us ready.
        if (!ready && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED")) {
          setReady(true);
        }

        // If we signed out, we're ready (and anonymous bootstrap will happen
        // on next navigation / reload outside of /auth/callback).
        if (event === "SIGNED_OUT" && !onAuthCallbackPath()) {
          setReady(true);
        }
      }
    );

    return () => {
      mounted = false;
      try {
        listener?.subscription?.unsubscribe();
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // One-time guest adoption
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !user) return;

    console.log("[AuthProvider] ready+user effect", {
      ready,
      userId: user.id,
    });

    const oldId = localStorage.getItem("guest_to_adopt");
    if (!oldId) return;
    if (isAnonymous(user)) return; // only adopt once we’re a real user

    (async () => {
      console.log("[AuthProvider] adopting guest:", oldId);
      const { error } = await supabase.rpc("adopt_guest", {
        p_old_user: oldId,
      });
      if (error) {
        console.warn("[AuthProvider] adopt_guest failed:", error);
        return;
      }
      console.log(
        "[AuthProvider] adopt_guest success → clearing guest_to_adopt"
      );
      localStorage.removeItem("guest_to_adopt");
    })();
  }, [ready, user?.id]);

  // ---------------------------------------------------------------------------
  // Email/password
  // ---------------------------------------------------------------------------
  async function signupOrLink(email, password) {
    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    if (current && isAnonymous(current)) {
      // Upgrade existing guest
      const oldGuestId = current.id;
      localStorage.setItem("guest_to_adopt", oldGuestId);
      const emailRedirectTo = buildRedirectURL();

      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo },
      });
      if (error) throw error;
      return { signedUp: true, upgradedGuest: true };
    }

    // Fresh signup
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
  // OAuth (Google, etc)
  // ---------------------------------------------------------------------------
  async function oauthSignIn(provider) {
    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    let guestId = null;
    if (current && isAnonymous(current)) {
      guestId = current.id;
      localStorage.setItem("guest_to_adopt", guestId);
    }

    const redirectTo =
      typeof window !== "undefined" ? buildRedirectURL() : undefined;

    console.log("[AuthProvider] oauthSignIn →", {
      provider,
      redirectTo,
      guestId,
    });

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo, // Supabase will send Google → this URL with ?code=...
      },
    });

    if (error) throw error;
    return { started: true };
  }

  // ---------------------------------------------------------------------------
  // Sign out → back to fresh anonymous
  // ---------------------------------------------------------------------------
  const signout = async () => {
    try {
      setReady(false);
      await supabase.auth.signOut();

      // Start a new anonymous session (normal app flow; not on callback)
      if (!onAuthCallbackPath()) {
        const { data: anonRes, error: anonErr } =
          await supabase.auth.signInAnonymously();
        if (anonErr) {
          console.error(
            "[AuthProvider] anon after signout failed:",
            anonErr.message || anonErr
          );
          setUser(null);
        } else {
          setUser(anonRes?.user ?? null);
        }
      }
    } catch (e) {
      console.error("[AuthProvider] signout error:", e);
      setUser(null);
    } finally {
      if (!onAuthCallbackPath()) {
        setReady(true);
      }
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
