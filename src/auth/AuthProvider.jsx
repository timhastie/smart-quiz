// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import {
  clearOauthRedirect,
  isOauthRedirectActive,
  markOauthRedirect,
} from "./oauthRedirectFlag";
import SigningInOverlay from "../components/SigningInOverlay";

const AuthCtx = createContext(null);

const LS_GUEST_ID = "guest_id_before_oauth";
const LS_OAUTH_RETURN_PATH = "oauth_return_path";

const onAuthCallbackPath = () =>
  typeof window !== "undefined" &&
  window.location.pathname.startsWith("/auth/callback");

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [oauthRedirecting, setOauthRedirecting] = useState(() => {
    const active = isOauthRedirectActive();
    return active;
  });

  // ---------- helpers ----------
  async function waitForSession(timeoutMs = 2500) {
    const start = Date.now();
    while (true) {
      const { data } = await supabase.auth.getSession();
      const sid = data?.session?.user?.id ?? null;
      if (sid) {
        return data.session;
      }
      if (Date.now() - start > timeoutMs) {
        console.warn("[AuthProvider] waitForSession timeout", {
          elapsedMs: Date.now() - start,
        });
        return null;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  async function resetToAnonymous(tag = "reset") {
    await supabase.auth.signOut();
    const { error: anonErr } = await supabase.auth.signInAnonymously();
    if (anonErr) {
      console.error("[AuthProvider] signInAnonymously error", {
        tag,
        error: anonErr,
      });
      return null;
    }
    const s = await waitForSession();
    if (s) {
      setSession(s);
      setUser(s.user);
    } else {
      console.warn("[AuthProvider] resetToAnonymous failed to get anon session", {
        tag,
      });
    }
    return s;
  }

  // --- central: ensure we actually HAVE a valid session (creates anon if needed)
  async function ensureSession(reason = "unknown") {
    // If we are on /auth/callback, don’t touch session bootstrap here.
    if (onAuthCallbackPath()) {
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);
      return data.session ?? null;
    }

    // 1) Do we have any session?
    let { data: s } = await supabase.auth.getSession();

    if (!s?.session) {
      console.warn("[AuthProvider] ensureSession: no session, resetting anon", {
        reason,
      });
      const anon = await resetToAnonymous("no-session");
      return anon;
    }

    // 2) Probe the token with /auth/v1/user. If 401/403 or missing user, self-heal.
    const probe = await supabase.auth.getUser();
    const bad =
      probe.error?.status === 401 ||
      probe.error?.status === 403 ||
      !probe.data?.user;

    if (bad) {
      console.warn(
        "[AuthProvider] ensureSession: stale/invalid token, resetting anon",
        { reason }
      );
      const anon = await resetToAnonymous("stale-token");
      return anon;
    }

    // 3) Looks good; persist state.
    setSession(s.session);
    setUser(s.session.user);
    return s.session;
  }

  // ---------- boot ----------
  useEffect(() => {
    let unsub;
    (async () => {
      // prime local state with whatever exists
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);

      // subscribe to changes
      unsub = supabase.auth.onAuthStateChange((event, newSession) => {
        setSession(newSession ?? null);
        setUser(newSession?.user ?? null);
      }).data.subscription;

      // self-heal / create anon unless we're on the OAuth callback route
      const ensured = await ensureSession("boot");

      setReady(true);

      if (!onAuthCallbackPath()) {
        clearOauthRedirect();
        setOauthRedirecting(false);
      }
    })();

    return () => {
      unsub?.unsubscribe();
    };
  }, []);

  // ---------- sign-in / sign-up / oauth ----------

  // Google OAuth (and other providers) — always redirect to /auth/callback
  async function oauthOrLink(provider) {

    markOauthRedirect();
    setOauthRedirecting(true);

    // Remember current guest id so /auth/callback can adopt it
    const {
      data: { user: current },
    } = await supabase.auth.getUser();
    const currentId = current?.id ?? null;

    if (currentId && typeof window !== "undefined") {
      try {
        localStorage.setItem(LS_GUEST_ID, currentId);
      } catch (e) {
        console.warn(
          "[AuthProvider] oauthOrLink failed to write LS_GUEST_ID to localStorage",
          e
        );
      }
    }

    // Remember where to send the user back after OAuth (e.g. /share/:slug)
    if (typeof window !== "undefined") {
      try {
        const path = window.location.pathname + window.location.search;
        localStorage.setItem(LS_OAUTH_RETURN_PATH, path);
      } catch (e) {
        console.warn(
          "[AuthProvider] oauthOrLink failed to write LS_OAUTH_RETURN_PATH",
          e
        );
      }
    }

    try {
      // local sign-out avoids identity linking; the redirect flow will auth afresh
      await supabase.auth.signOut({ scope: "local" });

      const redirectTo = `${window.location.origin}/auth/callback`;

      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
          queryParams: { access_type: "online", prompt: "select_account" },
        },
      });
      if (error) {
        console.error("[AuthProvider] oauthOrLink signInWithOAuth error", {
          provider,
          error,
        });
        throw error;
      }
    } catch (err) {
      console.error("[AuthProvider] oauthOrLink caught error", {
        provider,
        err,
      });
      clearOauthRedirect();
      setOauthRedirecting(false);
      throw err;
    }
  }

  // EMAIL + PASSWORD SIGN-IN:
  // New behavior: do NOT redirect through /auth/callback.
  // We adopt the guest inline via RPC, then refresh the session.
  async function signin(email, password) {

    // 1) Remember current guest id (the anon we want to adopt)
    let guestId = null;
    try {
      const {
        data: { user: current },
      } = await supabase.auth.getUser();
      guestId = current?.id ?? null;

      if (guestId && typeof window !== "undefined") {
        try {
          localStorage.setItem(LS_GUEST_ID, guestId);
        } catch (e) {
          console.warn(
            "[AuthProvider] signin failed to write LS_GUEST_ID to localStorage",
            e
          );
        }
      }
    } catch (e) {
      console.warn("[AuthProvider] signin getUser threw", { email, error: e });
    }

    // 2) Password sign-in
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      console.error("[AuthProvider] signin signInWithPassword error", {
        email,
        error,
      });
      return { error };
    }
    const newUserId = data.user?.id ?? null;

    // 3) If we had a guestId and it’s different from new user id, adopt guest now.
    if (guestId && guestId !== newUserId) {
      try {
        const { error: adoptErr, data: adoptData } = await supabase.rpc(
          "adopt_guest",
          { p_old_user: guestId }
        );
        if (adoptErr) {
          console.error("[AuthProvider] signin adopt_guest RPC error", {
            guestId,
            newUserId,
            message: adoptErr.message,
            details: adoptErr.details,
            hint: adoptErr.hint,
            code: adoptErr.code,
          });
        }
      } catch (e) {
        console.error("[AuthProvider] signin adopt_guest RPC threw", {
          guestId,
          newUserId,
          error: e,
        });
      }
    }

    // 4) Clean up LS flag
    try {
      localStorage.removeItem(LS_GUEST_ID);
    } catch (e) {
      console.warn(
        "[AuthProvider] signin failed to remove LS_GUEST_ID from localStorage",
        e
      );
    }

    // 5) Refresh local session state
    await ensureSession("after-password-signin");

    return { user: data.user };
  }

  // EMAIL + PASSWORD SIGN-UP:
  // Store current guest id and send confirmation link to /auth/callback.
  async function signup(email, password) {

    const {
      data: { user: current },
    } = await supabase.auth.getUser();
    const currentId = current?.id ?? null;

    if (currentId && typeof window !== "undefined") {
      try {
        localStorage.setItem(LS_GUEST_ID, currentId);
      } catch (e) {
        console.warn(
          "[AuthProvider] signup failed to write LS_GUEST_ID to localStorage",
          e
        );
      }
    }

    const redirectTo =
      typeof window !== "undefined"
        ? `${window.location.origin}/auth/callback`
        : undefined;

    const signUpArgs = { email, password };
    if (redirectTo) {
      signUpArgs.options = { emailRedirectTo: redirectTo };
    }

    const { data, error } = await supabase.auth.signUp(signUpArgs);
    if (error) {
      console.error("[AuthProvider] signup error", { email, error });
      return { error };
    }

    return { user: data.user };
  }

  async function signout() {

    await supabase.auth.signOut();

    if (!onAuthCallbackPath()) {
      await resetToAnonymous("signout");
    }
  }

  const value = useMemo(
    () => ({
      ready,
      session,
      user,
      oauthRedirecting,
      ensureSession, // callers (e.g., Generate button) can await this
      oauthOrLink,
      googleSignIn: () => oauthOrLink("google"),
      signin,
      signup,
      signout,
      LS_GUEST_ID,
    }),
    [ready, session, user, oauthRedirecting]
  );

  // Gate UI until we know the token is valid to avoid early 401s
  if (!ready) {
    if (oauthRedirecting) {
      return <SigningInOverlay />;
    }
    return <div className="min-h-screen bg-[#041c21]" aria-hidden="true" />;
  }

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
