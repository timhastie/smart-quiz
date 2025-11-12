// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);

// Keep in sync with your router
export function onAuthCallbackPath() {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/auth/callback");
}

const LS_GUEST_ID = "guest_id_before_oauth";

function isAnonymousUser(u) {
  if (!u) return false;
  if (u.is_anonymous === true) return true;
  if (u.user_metadata?.is_anonymous === true) return true;
  const prov = u.app_metadata?.provider || null;
  const provs = Array.isArray(u.app_metadata?.providers) ? u.app_metadata.providers : [];
  if (prov === "anonymous" || provs.includes("anonymous")) return true;
  if (Array.isArray(u.identities) && u.identities.some((i) => i?.provider === "anonymous")) return true;
  return false;
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let unsub = null;
    (async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);

      console.log("[AuthBoot] initial session:", data.session);
      console.log("[AuthBoot] initial user:", data.session?.user);

      unsub = supabase.auth.onAuthStateChange((event, newSession) => {
        console.log("[AuthStateChange]", { event, newSession, user: newSession?.user });
        setSession(newSession ?? null);
        setUser(newSession?.user ?? null);
      }).data.subscription;

      if (!onAuthCallbackPath()) {
        if (!data.session) {
          console.log("[AuthBoot] no session → signInAnonymously()");
          await supabase.auth.signInAnonymously();
          const { data: s2 } = await supabase.auth.getSession();
          console.log("[AuthBoot] anon session created:", s2.session);
          setSession(s2.session ?? null);
          setUser(s2.session?.user ?? null);
        } else {
          console.log("[AuthBoot] session exists, skip anon sign-in");
        }
      } else {
        console.log("[AuthBoot] on /auth/callback, skip anon bootstrap");
      }

      setReady(true);
    })();

    return () => {
      try { unsub?.unsubscribe(); } catch {}
    };
  }, []);

  // Always redirect; do NOT call linkIdentity (causes "Identity already linked" when reused Google).
  async function oauthOrLink(provider = "google") {
    try {
      const { data: ures } = await supabase.auth.getUser();
      const me = ures?.user || null;
      const isAnon = isAnonymousUser(me);

      console.log("[oauthOrLink] start", {
        currentUserId: me?.id || null,
        isAnon,
        providers: me?.app_metadata?.providers || null,
      });

      try {
        if (me?.id && isAnon) {
          localStorage.setItem(LS_GUEST_ID, me.id);
          console.log("[oauthOrLink] stored guest id:", me.id);
        } else {
          localStorage.removeItem(LS_GUEST_ID);
          console.log("[oauthOrLink] cleared guest id (not anon).");
        }
      } catch (e) {
        console.warn("[oauthOrLink] localStorage error:", e);
      }

      const redirectTo = `${window.location.origin}/auth/callback`;
      console.log("[oauthOrLink] redirecting to provider:", provider, "redirectTo:", redirectTo, "flowType: pkce");

      // Use PKCE/code flow (preferred)
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
          queryParams: { prompt: "select_account", access_type: "online" },
          flowType: "pkce",
        },
      });

      if (error) {
        console.error("[oauthOrLink] signInWithOAuth error:", error);
        alert(error.message || "Sign-in failed.");
      }
    } catch (e) {
      console.error("[oauthOrLink] unexpected error:", e);
      alert(e?.message || "Sign-in failed.");
    }
  }

  async function signin(email, password) {
    console.log("[signin] with email:", email);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      console.error("[signin] error:", error);
      return { error };
    }
    console.log("[signin] success user:", data.user);
    return { user: data.user };
  }

  async function signup(email, password) {
    console.log("[signup] with email:", email);
    const { data: ures } = await supabase.auth.getUser();
    const me = ures?.user || null;
    if (me?.id) {
      try {
        localStorage.setItem(LS_GUEST_ID, me.id);
        console.log("[signup] stored guest id for adoption:", me.id);
      } catch (e) {
        console.warn("[signup] localStorage error:", e);
      }
    }
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      console.error("[signup] error:", error);
      return { error };
    }
    console.log("[signup] initiated (confirm email may be required). data:", data);
    return { user: data.user };
  }

  async function signout() {
    console.log("[signout] signing out…");
    await supabase.auth.signOut();
    if (!onAuthCallbackPath()) {
      console.log("[signout] recreate anonymous session");
      await supabase.auth.signInAnonymously();
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);
    } else {
      setSession(null);
      setUser(null);
    }
  }

  const value = useMemo(
    () => ({ ready, session, user, oauthOrLink, signin, signup, signout }),
    [ready, session, user]
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
