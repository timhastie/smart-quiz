// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);

// --- Helpers ---------------------------------------------------------------
function onAuthCallbackPath() {
  return window.location.pathname.startsWith("/auth/callback");
}
const LS_GUEST_ID = "guest_id_before_oauth";

// --- Provider --------------------------------------------------------------
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
      console.log("[AuthBoot] initial user:", data.session?.user);

      unsub = supabase.auth.onAuthStateChange((event, newSession) => {
        console.log("[AuthStateChange]", { event, newSession });
        setSession(newSession ?? null);
        setUser(newSession?.user ?? null);
      }).data.subscription;

      // Create or reuse an anonymous session unless we’re on the OAuth callback page
      if (!onAuthCallbackPath()) {
        if (!data.session) {
          console.log("[AuthBoot] no session -> signInAnonymously");
          await supabase.auth.signInAnonymously();
          const { data: s2 } = await supabase.auth.getSession();
          setSession(s2.session ?? null);
          setUser(s2.session?.user ?? null);
          console.log("[AuthBoot] post-anon session:", s2.session);
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

  // --- OAuth as SIGN-IN (not link). We explicitly sign out first. -----------
  async function oauthOrLink(provider) {
    const current = (await supabase.auth.getUser()).data.user;
    const currentId = current?.id ?? null;
    const isAnon = !!current?.app_metadata?.provider?.includes?.("anonymous") ||
                   (current?.app_metadata?.provider === "anonymous");

    console.log("[oauthOrLink] start", {
      currentUserId: currentId,
      isAnon,
      provider,
      path: window.location.pathname,
    });

    // Remember the guest we want to adopt later
    if (currentId) {
      try {
        localStorage.setItem(LS_GUEST_ID, currentId);
        console.log("[oauthOrLink] stored guest id:", currentId);
      } catch (e) {
        console.warn("[oauthOrLink] failed to store guest id:", e);
      }
    }

    // Critical: sign out so Supabase does NOT try to link the identity
    // (linking causes "Identity is already linked to another user")
    console.log("[oauthOrLink] signing out BEFORE OAuth to avoid linking");
    await supabase.auth.signOut({ scope: "local" });

    const redirectTo = `${window.location.origin}/auth/callback`;
    console.log("[oauthOrLink] redirecting to provider; redirectTo:", redirectTo);

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
        // These are UX niceties; they don’t affect linking behavior
        queryParams: {
          access_type: "online",
          prompt: "select_account",
        },
      },
    });

    if (error) {
      console.error("[oauthOrLink] signInWithOAuth error:", error);
      throw error;
    }
  }

  async function signin(email, password) {
    console.log("[password signin] start", { email });
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      console.error("[password signin] error:", error);
      return { error };
    }
    console.log("[password signin] success user:", data.user?.id);
    return { user: data.user };
  }

  async function signup(email, password) {
    const current = (await supabase.auth.getUser()).data.user;
    if (current?.id) {
      try {
        localStorage.setItem(LS_GUEST_ID, current.id);
        console.log("[signup] stored guest id:", current.id);
      } catch (e) {
        console.warn("[signup] failed to store guest id:", e);
      }
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
      await supabase.auth.signInAnonymously();
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);
      console.log("[signout] anon session:", data.session);
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
