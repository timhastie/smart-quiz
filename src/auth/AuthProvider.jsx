// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);

// ---- Helpers --------------------------------------------------------------
function onAuthCallbackPath() {
  return window.location.pathname.startsWith("/auth/callback");
}
const LS_GUEST_ID = "guest_id_before_oauth";

/**
 * Create (or reuse) an anonymous session.
 * IMPORTANT: Only sets LS_GUEST_ID if it is currently empty.
 */
async function ensureAnon(tag = "boot") {
  console.log(`[AuthBoot] ensureAnon(${tag})`);
  const { data: s0 } = await supabase.auth.getSession();
  if (s0.session?.user) {
    console.log("[AuthBoot] already have session:", s0.session.user.id);
    return s0.session;
  }

  await supabase.auth.signInAnonymously();
  const { data: s1 } = await supabase.auth.getSession();
  const anonId = s1.session?.user?.id;
  console.log("[AuthBoot] created anon:", anonId);

  try {
    const already = localStorage.getItem(LS_GUEST_ID);
    if (!already && anonId) {
      localStorage.setItem(LS_GUEST_ID, anonId);
      console.log("[AuthBoot] stored first guest id:", anonId);
    } else if (already && already !== anonId) {
      console.log("[AuthBoot] NOT overwriting existing guest id", {
        existing: already,
        newAnon: anonId,
      });
    }
  } catch (e) {
    console.warn("[AuthBoot] failed to write LS_GUEST_ID:", e);
  }

  return s1.session ?? null;
}

// ---- Provider -------------------------------------------------------------
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let unsub = null;

    (async () => {
      console.log("[AuthBoot] start");
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);
      console.log("[AuthBoot] initial session:", data.session);
      console.log("[AuthBoot] initial user:", data.session?.user?.id);

      unsub = supabase.auth.onAuthStateChange((event, newSession) => {
        console.log("[AuthStateChange]", { event, newSession });
        setSession(newSession ?? null);
        setUser(newSession?.user ?? null);
      }).data.subscription;

      if (!onAuthCallbackPath()) {
        if (!data.session) {
          const s = await ensureAnon("boot");
          setSession(s ?? null);
          setUser(s?.user ?? null);
        } else {
          console.log("[AuthBoot] session exists, skip anon sign-in");
        }
      } else {
        console.log("[AuthBoot] on callback path -> skip anon bootstrap");
      }

      setReady(true);
    })();

    return () => {
      if (unsub) unsub.unsubscribe();
    };
  }, []);

  // ---- OAuth sign-in (NOT link) ------------------------------------------
  async function oauthOrLink(provider) {
    const { data: me } = await supabase.auth.getUser();
    const currentId = me.user?.id ?? null;

    console.log("[oauthOrLink] start", {
      currentUserId: currentId,
      provider,
      path: window.location.pathname,
    });

    // Record the FIRST guest id only (do not overwrite if already set)
    try {
      const already = localStorage.getItem(LS_GUEST_ID);
      if (!already && currentId) {
        localStorage.setItem(LS_GUEST_ID, currentId);
        console.log("[oauthOrLink] stored guest id:", currentId);
      } else {
        console.log("[oauthOrLink] keeping existing guest id:", already);
      }
    } catch (e) {
      console.warn("[oauthOrLink] failed to store guest id:", e);
    }

    // Sign out so Supabase doesn’t try to LINK identities
    console.log("[oauthOrLink] signing out BEFORE OAuth to avoid linking");
    await supabase.auth.signOut({ scope: "local" });

    const redirectTo = `${window.location.origin}/auth/callback`;
    console.log("[oauthOrLink] redirecting to provider; redirectTo:", redirectTo);

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
        queryParams: { access_type: "online", prompt: "select_account" },
      },
    });
    if (error) {
      console.error("[oauthOrLink] signInWithOAuth error:", error);
      throw error;
    }
  }

  async function signin(email, password) {
    console.log("[password signin] start", { email });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      console.error("[password signin] error:", error);
      return { error };
    }
    console.log("[password signin] success user:", data.user?.id);
    return { user: data.user };
  }

  async function signup(email, password) {
    const { data: me } = await supabase.auth.getUser();
    const currentId = me.user?.id ?? null;

    // Preserve first guest id only
    try {
      const already = localStorage.getItem(LS_GUEST_ID);
      if (!already && currentId) {
        localStorage.setItem(LS_GUEST_ID, currentId);
        console.log("[signup] stored guest id:", currentId);
      } else {
        console.log("[signup] keeping existing guest id:", already);
      }
    } catch (e) {
      console.warn("[signup] failed to store guest id:", e);
    }

    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      console.error("[signup] error:", error);
      return { error };
    }
    console.log("[signup] success user:", data.user?.id);
    return { user: data.user };
  }

  async function signout() {
    console.log("[signout] signing out..");
    await supabase.auth.signOut();
    console.log("[signout] recreate anonymous session");
    if (!onAuthCallbackPath()) {
      const s = await ensureAnon("signout");
      setSession(s ?? null);
      setUser(s?.user ?? null);
      console.log("[signout] anon session:", s);
    }
  }

  const value = useMemo(
    () => ({
      ready,
      session,
      user,
      oauthOrLink,
      signin,
      signup,
      signout,
    }),
    [ready, session, user]
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
