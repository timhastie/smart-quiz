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
const onAuthCallbackPath = () =>
  typeof window !== "undefined" &&
  window.location.pathname.startsWith("/auth/callback");

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [oauthRedirecting, setOauthRedirecting] = useState(() => {
    const active = isOauthRedirectActive();
    if (typeof window !== "undefined") {
      console.log("[AuthProvider] initial oauthRedirecting from flag:", {
        active,
        path: window.location.pathname,
      });
    } else {
      console.log(
        "[AuthProvider] initial oauthRedirecting from flag (no window):",
        { active }
      );
    }
    return active;
  });

  console.log("[AuthProvider] render", {
    ready,
    oauthRedirecting,
    hasSession: !!session,
    userId: user?.id ?? null,
  });

  // ---------- helpers ----------
  async function waitForSession(timeoutMs = 2500) {
    const start = Date.now();
    console.log("[AuthProvider] waitForSession start", { timeoutMs });
    while (true) {
      const { data } = await supabase.auth.getSession();
      const sid = data?.session?.user?.id ?? null;
      if (sid) {
        console.log("[AuthProvider] waitForSession got session", {
          userId: sid,
          elapsedMs: Date.now() - start,
        });
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
    console.log("[AuthProvider] resetToAnonymous called", { tag });
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
      console.log("[AuthProvider] resetToAnonymous got anon session", {
        tag,
        userId: s.user?.id,
      });
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
    const path =
      typeof window !== "undefined" ? window.location.pathname : "(no-window)";
    console.log("[AuthProvider] ensureSession called", { reason, path });

    // If we are on /auth/callback, don’t touch session bootstrap here.
    if (onAuthCallbackPath()) {
      console.log(
        "[AuthProvider] ensureSession early exit: on /auth/callback route"
      );
      const { data } = await supabase.auth.getSession();
      console.log("[AuthProvider] ensureSession (/auth/callback) session", {
        hasSession: !!data.session,
        userId: data.session?.user?.id ?? null,
      });
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);
      return data.session ?? null;
    }

    // 1) Do we have any session?
    let { data: s } = await supabase.auth.getSession();
    console.log("[AuthProvider] ensureSession current getSession result", {
      hasSession: !!s?.session,
      userId: s?.session?.user?.id ?? null,
    });

    if (!s?.session) {
      console.warn("[AuthProvider] ensureSession: no session, resetting anon", {
        reason,
      });
      const anon = await resetToAnonymous("no-session");
      console.log("[AuthProvider] ensureSession after resetToAnonymous", {
        reason,
        anonUserId: anon?.user?.id ?? null,
      });
      return anon;
    }

    // 2) Probe the token with /auth/v1/user. If 401/403 or missing user, self-heal.
    const probe = await supabase.auth.getUser();
    const bad =
      probe.error?.status === 401 ||
      probe.error?.status === 403 ||
      !probe.data?.user;

    console.log("[AuthProvider] ensureSession probe result", {
      reason,
      bad,
      probeError: probe.error ?? null,
      probeUserId: probe.data?.user?.id ?? null,
    });

    if (bad) {
      console.warn(
        "[AuthProvider] ensureSession: stale/invalid token, resetting anon",
        { reason }
      );
      const anon = await resetToAnonymous("stale-token");
      console.log("[AuthProvider] ensureSession after stale resetToAnonymous", {
        reason,
        anonUserId: anon?.user?.id ?? null,
      });
      return anon;
    }

    // 3) Looks good; persist state.
    console.log("[AuthProvider] ensureSession: token OK, using existing session", {
      reason,
      userId: s.session.user?.id ?? null,
    });
    setSession(s.session);
    setUser(s.session.user);
    return s.session;
  }

  // ---------- boot ----------
  useEffect(() => {
    console.log("[AuthProvider] boot useEffect started");
    let unsub;
    (async () => {
      // prime local state with whatever exists
      const { data } = await supabase.auth.getSession();
      console.log("[AuthProvider] boot initial getSession", {
        hasSession: !!data.session,
        userId: data.session?.user?.id ?? null,
      });
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);

      // subscribe to changes
      unsub = supabase.auth.onAuthStateChange((event, newSession) => {
        console.log("[AuthProvider] onAuthStateChange", {
          event,
          hasSession: !!newSession,
          userId: newSession?.user?.id ?? null,
        });
        setSession(newSession ?? null);
        setUser(newSession?.user ?? null);
      }).data.subscription;

      // self-heal / create anon unless we're on the OAuth callback route
      const ensured = await ensureSession("boot");
      console.log("[AuthProvider] boot ensureSession result", {
        ensuredUserId: ensured?.user?.id ?? null,
      });

      setReady(true);
      console.log("[AuthProvider] boot setReady(true)");

      if (!onAuthCallbackPath()) {
        console.log(
          "[AuthProvider] boot clearing oauth redirect flag (not on /auth/callback)"
        );
        clearOauthRedirect();
        setOauthRedirecting(false);
      } else {
        console.log(
          "[AuthProvider] boot: on /auth/callback, leaving oauthRedirecting as-is"
        );
      }
    })();

    return () => {
      console.log("[AuthProvider] boot useEffect cleanup");
      unsub?.unsubscribe();
    };
  }, []);

  // ---------- sign-in / sign-up / oauth ----------

  // Google OAuth (and other providers) — always redirect to /auth/callback
  async function oauthOrLink(provider) {
    console.log("[AuthProvider] oauthOrLink called", { provider });

    markOauthRedirect();
    setOauthRedirecting(true);

    // Remember current guest id so /auth/callback can adopt it
    const {
      data: { user: current },
    } = await supabase.auth.getUser();
    const currentId = current?.id ?? null;
    console.log("[AuthProvider] oauthOrLink current user before OAuth", {
      provider,
      currentId,
    });

    if (currentId && typeof window !== "undefined") {
      try {
        localStorage.setItem(LS_GUEST_ID, currentId);
        console.log("[AuthProvider] oauthOrLink stored LS_GUEST_ID", {
          key: LS_GUEST_ID,
          value: currentId,
        });
      } catch (e) {
        console.warn(
          "[AuthProvider] oauthOrLink failed to write LS_GUEST_ID to localStorage",
          e
        );
      }
    }

    try {
      // local sign-out avoids identity linking; the redirect flow will auth afresh
      console.log("[AuthProvider] oauthOrLink signing out (scope: local)");
      await supabase.auth.signOut({ scope: "local" });

      const redirectTo = `${window.location.origin}/auth/callback`;
      console.log("[AuthProvider] oauthOrLink calling signInWithOAuth", {
        provider,
        redirectTo,
      });

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
      console.log("[AuthProvider] oauthOrLink signInWithOAuth completed", {
        provider,
      });
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
    console.log("[AuthProvider] signin called", { email });

    // 1) Remember current guest id (the anon we want to adopt)
    let guestId = null;
    try {
      const {
        data: { user: current },
      } = await supabase.auth.getUser();
      guestId = current?.id ?? null;
      console.log("[AuthProvider] signin current user before password sign-in", {
        email,
        guestId,
      });

      if (guestId && typeof window !== "undefined") {
        try {
          localStorage.setItem(LS_GUEST_ID, guestId);
          console.log("[AuthProvider] signin stored LS_GUEST_ID", {
            key: LS_GUEST_ID,
            value: guestId,
          });
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
    console.log("[AuthProvider] signin signInWithPassword success", {
      email,
      userId: newUserId,
    });

    // 3) If we had a guestId and it’s different from new user id, adopt guest now.
    if (guestId && guestId !== newUserId) {
      try {
        console.log("[AuthProvider] signin calling adopt_guest RPC", {
          guestId,
          newUserId,
        });
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
        } else {
          console.log("[AuthProvider] signin adopt_guest RPC success", {
            guestId,
            newUserId,
            data: adoptData,
          });
        }
      } catch (e) {
        console.error("[AuthProvider] signin adopt_guest RPC threw", {
          guestId,
          newUserId,
          error: e,
        });
      }
    } else {
      console.log("[AuthProvider] signin no adoption needed", {
        guestId,
        newUserId,
      });
    }

    // 4) Clean up LS flag
    try {
      localStorage.removeItem(LS_GUEST_ID);
      console.log("[AuthProvider] signin removed LS_GUEST_ID", {
        key: LS_GUEST_ID,
      });
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
    console.log("[AuthProvider] signup called", { email });

    const {
      data: { user: current },
    } = await supabase.auth.getUser();
    const currentId = current?.id ?? null;
    console.log("[AuthProvider] signup current user before signUp", {
      email,
      currentId,
    });

    if (currentId && typeof window !== "undefined") {
      try {
        localStorage.setItem(LS_GUEST_ID, currentId);
        console.log("[AuthProvider] signup stored LS_GUEST_ID", {
          key: LS_GUEST_ID,
          value: currentId,
        });
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

    console.log("[AuthProvider] signup calling signUp", {
      email,
      hasRedirectTo: !!redirectTo,
      redirectTo,
    });

    const { data, error } = await supabase.auth.signUp(signUpArgs);
    if (error) {
      console.error("[AuthProvider] signup error", { email, error });
      return { error };
    }

    console.log("[AuthProvider] signup success", {
      email,
      userId: data.user?.id ?? null,
    });

    return { user: data.user };
  }

  async function signout() {
    console.log("[AuthProvider] signout called", {
      userId: user?.id ?? null,
      path:
        typeof window !== "undefined"
          ? window.location.pathname
          : "(no-window)",
    });

    await supabase.auth.signOut();
    console.log("[AuthProvider] signout supabase.signOut() done");

    if (!onAuthCallbackPath()) {
      console.log("[AuthProvider] signout resetting to anonymous");
      await resetToAnonymous("signout");
    } else {
      console.log(
        "[AuthProvider] signout on /auth/callback, not resetting anonymous"
      );
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
    console.log("[AuthProvider] not ready, gating UI", {
      oauthRedirecting,
    });
    if (oauthRedirecting) {
      return <SigningInOverlay />;
    }
    return <div className="min-h-screen bg-[#041c21]" aria-hidden="true" />;
  }

  console.log("[AuthProvider] ready, rendering children", {
    userId: user?.id ?? null,
  });

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
