// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// Build callback URL; optionally embed guest id for cross-device adoption.
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

  // --- 1) Bootstrap session: existing -> use it; else anon (not on /auth/callback)
  useEffect(() => {
    let mounted = true;

    async function ensureSession() {
      console.log("[AuthProvider] bootstrap start, path:", window.location.pathname);
      try {
        const { data: sess, error } = await supabase.auth.getSession();
        if (error) console.warn("[AuthProvider] getSession error:", error);

        if (sess?.session?.user) {
          console.log("[AuthProvider] existing session user:", sess.session.user.id);
          if (mounted) setUser(sess.session.user);
          return;
        }

        if (!onAuthCallbackPath()) {
          console.log("[AuthProvider] no session -> starting anonymous");
          const { data: anonRes, error: anonErr } = await supabase.auth.signInAnonymously();
          if (anonErr) {
            console.error("[AuthProvider] anonymous sign-in failed:", anonErr);
            if (mounted) setUser(null);
            return;
          }
          console.log("[AuthProvider] anonymous user:", anonRes?.user?.id);
          if (mounted) setUser(anonRes?.user ?? null);
        } else {
          console.log("[AuthProvider] on /auth/callback -> let AuthCallback drive");
        }
      } finally {
        if (mounted) {
          console.log("[AuthProvider] bootstrap complete");
          setReady(true);
        }
      }
    }

    ensureSession();

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      console.log("[AuthProvider] onAuthStateChange:", event, session?.user?.id || null);
      if (!mounted) return;
      setUser(session?.user ?? null);
    });

    return () => {
      mounted = false;
      try {
        listener?.subscription?.unsubscribe();
      } catch {}
    };
  }, []);

  // --- helper: detect anonymous
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

  // --- 2) Safety-net adopt: if a real user appears and we still have guest_to_adopt
  useEffect(() => {
    if (!ready || !user) return;
    const oldId = localStorage.getItem("guest_to_adopt");
    if (!oldId) return;
    if (isAnonymous(user)) return;

    (async () => {
      if (oldId === user.id) {
        console.log("[AuthProvider] guest_to_adopt matches current user; clearing.");
        localStorage.removeItem("guest_to_adopt");
        return;
      }

      console.log("[AuthProvider] safety adopt_guest for:", oldId, "->", user.id);
      const { error } = await supabase.rpc("adopt_guest", { p_old_user: oldId });
      if (error) {
        console.warn("[AuthProvider] safety adopt_guest failed:", error);
      } else {
        console.log("[AuthProvider] safety adopt_guest success; clearing marker");
        localStorage.removeItem("guest_to_adopt");
      }
    })();
  }, [ready, user?.id]);

  // --- 3) Email/password signup (kept from your original)
  async function signupOrLink(email, password) {
    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    if (current && isAnonymous(current)) {
      const oldGuestId = current.id;
      localStorage.setItem("guest_to_adopt", oldGuestId);
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

  // --- 4) OAuth: if anon -> try linkIdentity; else -> signInWithOAuth
  async function oauthOrLink(provider) {
    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    if (current && isAnonymous(current)) {
      // We're a guest; mark for possible adoption (cross-device) and try upgrading.
      const guestId = current.id;
      localStorage.setItem("guest_to_adopt", guestId);
      const redirectTo = buildRedirectURL(guestId);

      console.log("[AuthProvider] oauthOrLink: linking", provider, "for guest", guestId);

      const { error } = await supabase.auth.linkIdentity({
        provider,
        options: { redirectTo },
      });

      if (error) {
        console.error("[AuthProvider] linkIdentity failed, falling back to signInWithOAuth:", error);
        const { error: fallbackErr } = await supabase.auth.signInWithOAuth({
          provider,
          options: { redirectTo },
        });
        if (fallbackErr) throw fallbackErr;
      }

      return { started: true };
    }

    // Already have a non-anon user: standard OAuth sign-in.
    const redirectTo = buildRedirectURL(null);
    console.log("[AuthProvider] oauthOrLink: signInWithOAuth", { provider, redirectTo });

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo },
    });
    if (error) throw error;
    return { started: true };
  }

  // --- 5) Signout: then start new anon session.
  const signout = async () => {
    setReady(false);
    await supabase.auth.signOut();

    const { data: anonRes, error: anonErr } = await supabase.auth.signInAnonymously();
    if (anonErr) {
      console.error("[AuthProvider] anon after signout failed:", anonErr);
      setUser(null);
    } else {
      console.log("[AuthProvider] anon after signout:", anonRes?.user?.id);
      setUser(anonRes?.user ?? null);
    }
    setReady(true);
  };

  return (
    <AuthCtx.Provider
      value={{
        user,
        ready,
        signupOrLink,
        signin,
        oauthOrLink,
        signout,
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
