// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// ---- Helpers ----

function isBrowser() {
  return typeof window !== "undefined";
}

function isOnAuthCallbackPath() {
  if (!isBrowser()) return false;
  return window.location.pathname.startsWith("/auth/callback");
}

function buildRedirectURL() {
  if (!isBrowser()) return "";
  // Must exactly match Supabase + Google redirect allow-lists
  return `${window.location.origin}/auth/callback`;
}

function isAnonymousUser(u) {
  if (!u) return false;
  const meta = u.app_metadata || {};
  const prov = meta.provider;
  const providers = Array.isArray(meta.providers) ? meta.providers : [];
  const identities = Array.isArray(u.identities) ? u.identities : [];

  return (
    u.is_anonymous === true ||
    u.user_metadata?.is_anonymous === true ||
    prov === "anonymous" ||
    providers.includes("anonymous") ||
    identities.some((i) => i?.provider === "anonymous") ||
    (!u.email && (providers.length === 0 || providers.includes("anonymous")))
  );
}

// ---- Provider ----

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // Initial bootstrap: get existing session or start anonymous (except on /auth/callback)
  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        console.log("[AuthProvider] bootstrap start, path:", isBrowser() ? window.location.pathname : "");

        const { data, error } = await supabase.auth.getSession();
        if (!active) return;

        if (error) {
          console.error("[AuthProvider] getSession error:", error);
          setUser(null);
        } else if (data?.session?.user) {
          console.log("[AuthProvider] existing session:", data.session.user.id);
          setUser(data.session.user);
        } else if (!isOnAuthCallbackPath()) {
          // No session -> create anonymous user (normal pages only)
          console.log("[AuthProvider] no session -> creating anonymous user");
          const { data: anonData, error: anonErr } = await supabase.auth.signInAnonymously();
          if (!active) return;
          if (anonErr) {
            console.error("[AuthProvider] signInAnonymously error:", anonErr);
            setUser(null);
          } else {
            console.log("[AuthProvider] anonymous user created:", anonData.user?.id);
            setUser(anonData.user ?? null);
          }
        }
      } catch (e) {
        if (!active) return;
        console.error("[AuthProvider] bootstrap exception:", e);
        setUser(null);
      } finally {
        if (active) {
          setReady(true);
          console.log("[AuthProvider] bootstrap complete, ready = true");
        }
      }
    }

    bootstrap();

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      console.log("[AuthProvider] onAuthStateChange:", event, {
        hasSession: !!session,
        userId: session?.user?.id || null,
      });
      setUser(session?.user ?? null);
      setReady(true);
    });

    return () => {
      active = false;
      try {
        sub?.subscription?.unsubscribe();
      } catch {}
    };
  }, []);

  // After we have a real (non-anon) user, adopt quizzes from stored guest id (once)
  useEffect(() => {
    if (!ready || !user || !isBrowser()) return;

    const marker = window.localStorage.getItem("guest_to_adopt");
    if (!marker) return;
    if (isAnonymousUser(user)) return; // still guest, wait until real user

    (async () => {
      try {
        console.log("[AuthProvider] adopt_guest start:", { from: marker, to: user.id });
        const { error } = await supabase.rpc("adopt_guest", {
          p_old_user: marker,
        });
        if (error) {
          console.warn("[AuthProvider] adopt_guest error:", error);
        } else {
          console.log("[AuthProvider] adopt_guest success, clearing marker");
          window.localStorage.removeItem("guest_to_adopt");
        }
      } catch (e) {
        console.warn("[AuthProvider] adopt_guest threw:", e);
      }
    })();
  }, [ready, user?.id]);

  // ---- Auth actions ----

  async function signup(email, password) {
    const redirectTo = buildRedirectURL();

    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    if (isAnonymousUser(current)) {
      // Remember guest for adoption after confirm email
      window.localStorage.setItem("guest_to_adopt", current.id);
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) throw error;
    return data;
  }

  async function signin(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    return data;
  }

  async function oauthSignIn(provider) {
    const redirectTo = buildRedirectURL();

    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    if (isAnonymousUser(current)) {
      console.log("[AuthProvider] oauthSignIn: tracking guest for adoption:", current.id);
      window.localStorage.setItem("guest_to_adopt", current.id);
    }

    console.log("[AuthProvider] oauthSignIn start:", { provider, redirectTo });

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
      },
    });
    if (error) throw error;
    return data;
  }

  async function signout() {
    console.log("[AuthProvider] signout");
    await supabase.auth.signOut();
    setUser(null);
    setReady(true);

    // Start a fresh anonymous session so they can still play
    try {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) {
        console.error("[AuthProvider] anon-after-signout error:", error);
      } else {
        console.log("[AuthProvider] anon-after-signout user:", data.user?.id);
        setUser(data.user ?? null);
      }
    } catch (e) {
      console.error("[AuthProvider] anon-after-signout threw:", e);
    }
  }

  return (
    <AuthCtx.Provider
      value={{
        user,
        ready,
        signup,
        signin,
        oauthSignIn,
        signout,
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
