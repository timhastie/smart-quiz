// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { clearGuestId, readGuestId, storeGuestId } from "./guestStorage";

const OAUTH_PENDING_KEY = "smartquiz_pending_oauth";
const OAUTH_PENDING_COOKIE = "smartquiz_auth_pending=1";
const OAUTH_PENDING_TOKENS = "smartquiz_pending_tokens";
const LAST_VISITED_ROUTE_KEY = "smartquiz_last_route";

function readStorage(key, storageGetter) {
  try {
    const store = storageGetter();
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStorage(key, value, storageGetter) {
  try {
    const store = storageGetter();
    if (!store) return;
    if (value === null) {
      store.removeItem(key);
    } else {
      store.setItem(key, value);
    }
  } catch {
    /* ignore */
  }
}

function setCookieFlag(isSet) {
  if (typeof document === "undefined") return;
  const base = `${OAUTH_PENDING_COOKIE.split("=")[0]}=`;
  if (isSet) {
    document.cookie = `${OAUTH_PENDING_COOKIE}; Path=/; Max-Age=60; SameSite=Lax`;
  } else {
    document.cookie = `${base}; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
  }
}

function hasCookieFlag() {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((c) =>
    c.trim().startsWith(OAUTH_PENDING_COOKIE.split("=")[0] + "=")
  );
}

const getPendingOAuthState = () => {
  if (typeof window === "undefined") return null;
  return (
    readStorage(OAUTH_PENDING_KEY, () => window.sessionStorage) ||
    readStorage(OAUTH_PENDING_KEY, () => window.localStorage)
  );
};

const setPendingOAuthState = (value) => {
  if (typeof window === "undefined") return;
  writeStorage(OAUTH_PENDING_KEY, value, () => window.sessionStorage);
  writeStorage(OAUTH_PENDING_KEY, value, () => window.localStorage);
  setCookieFlag(Boolean(value));
};

const storePendingTokens = (session) => {
  if (typeof window === "undefined" || !session) return;
  const payload = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
  };
  try {
    window.sessionStorage.setItem(OAUTH_PENDING_TOKENS, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
};

const readPendingTokens = () => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(OAUTH_PENDING_TOKENS);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const clearPendingTokens = () => {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(OAUTH_PENDING_TOKENS);
  } catch {
    /* ignore */
  }
};

function clearPendingOAuthArtifacts(url) {
  setPendingOAuthState(null);
  clearPendingTokens();
  if (url && url.searchParams?.get("from") === "auth") {
    url.searchParams.delete("from");
    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
  }
}

async function waitForSupabaseSession(timeoutMs = 8000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      console.warn("[AuthProvider] waitForSupabaseSession error:", error);
      break;
    }
    if (data?.session?.user) {
      console.log(
        "[AuthProvider] delayed session became available",
        data.session.user.id,
        "after",
        attempt,
        "polls"
      );
      return data.session;
    }
    const remaining = Math.max(0, deadline - Date.now());
    console.log(
      "[AuthProvider] waiting for Supabase session… attempt",
      attempt,
      "remaining",
      `${remaining}ms`
    );
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  console.warn("[AuthProvider] waitForSupabaseSession timed out");
  return null;
}

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// Build the callback URL; include the guest id when we have one.
function buildRedirectURL(guestId) {
  if (typeof window === "undefined") return "/auth/callback";
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

// Heuristic: does this user look anonymous?
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

/* -------------------------------------------
   OAuth adoption helper (Safari-safe)
   Returns true if we adopted and anon should be skipped.
-------------------------------------------- */
function clearOAuthReturnFlags() {
  try {
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
    sessionStorage.removeItem(LAST_VISITED_ROUTE_KEY);
    sessionStorage.removeItem(OAUTH_PENDING_TOKENS);
  } catch {}
}

async function adoptOAuthIfPending(supabaseClient) {
  try {
    const last = sessionStorage.getItem(LAST_VISITED_ROUTE_KEY);
    const pending = sessionStorage.getItem(OAUTH_PENDING_KEY);
    const tokensRaw = readPendingTokens();

    console.log("[AuthProvider] adoptOAuthIfPending check →", {
      last,
      pending,
      hasTokens: !!(tokensRaw?.access_token && tokensRaw?.refresh_token),
    });

    if (last !== "/auth/callback" && pending !== "returning") return false;

    let tokens = tokensRaw;
    if (!tokens?.access_token || !tokens?.refresh_token) {
      await new Promise((r) => setTimeout(r, 200));
      const again = readPendingTokens();
      if (again?.access_token && again?.refresh_token) tokens = again;
    }
    if (!tokens?.access_token || !tokens?.refresh_token) {
      console.warn("[AuthProvider] adoptOAuthIfPending → no tokens found");
      return false;
    }

    console.log("[AuthProvider] adopting OAuth session via setSession()");
    const { error } = await supabaseClient.auth.setSession({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    });
    if (error) console.warn("[AuthProvider] setSession error during adoption:", error);

    await new Promise((r) => setTimeout(r, 150));
    clearOAuthReturnFlags();
    console.log("[AuthProvider] adoption complete, flags cleared");
    return true;
  } catch (e) {
    console.warn("[AuthProvider] adoptOAuthIfPending threw:", e);
    return false;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // ---------------------------------------------------------------------------
  // 1) Bootstrap session
  //    - If there is an existing session, use it.
  //    - Otherwise create an anonymous session (except on /auth/callback).
  //    - NEW: adoptOAuthIfPending() runs before any anon bootstrap.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let mounted = true;

    async function ensureSession() {
      try {
        const url = new URL(window.location.href);
        console.log("[AuthProvider] bootstrap start, path:", window.location.pathname);

        // ***** EARLY OAUTH ADOPTION BARRIER (Chrome-safe) *****
        const adopted = await adoptOAuthIfPending(supabase);
        if (adopted) {
          const { data: after } = await supabase.auth.getSession();
          const u = after?.session?.user || null;
          console.log("[AuthProvider] post-adopt user →", u?.id || null);
          if (u && mounted) {
            clearPendingOAuthArtifacts(url);
            setUser(u);
            setReady(true);
            return;
          }
        }
        // ******************************************************

        let lastRoute = null;
        try {
          lastRoute = window.sessionStorage.getItem(LAST_VISITED_ROUTE_KEY);
          console.log("[AuthProvider] last recorded route", lastRoute);
        } catch (err) {
          console.warn("[AuthProvider] unable to read last route", err);
        }
        let pendingOAuth = getPendingOAuthState();
        if (!pendingOAuth && hasCookieFlag()) {
          pendingOAuth = "cookie";
        }
        const fromAuthParam = url.searchParams.get("from") === "auth";
        if (!pendingOAuth && fromAuthParam) {
          console.log("[AuthProvider] pending OAuth inferred from URL");
          pendingOAuth = "from-url";
        }
        if (pendingOAuth) {
          console.log("[AuthProvider] pending OAuth detected via", pendingOAuth);
        }
        let sessionUser = null;
        let shouldIgnoreExisting = false;
        const guestId = readGuestId();
        try {
          const { data: sess, error } = await supabase.auth.getSession();
          if (error) {
            console.error("[Auth] getSession error:", error);
          }
          sessionUser = sess?.session?.user ?? null;
          shouldIgnoreExisting = Boolean(
            pendingOAuth &&
              sessionUser &&
              (isAnonymous(sessionUser) || (guestId && guestId === sessionUser.id))
          );
        } catch (err) {
          console.error("[Auth] getSession threw:", err);
        }

        if (mounted && sessionUser && !shouldIgnoreExisting) {
          console.log("[AuthProvider] existing session user", sessionUser.id);
          clearPendingOAuthArtifacts(url);
          setUser(sessionUser);
          return;
        }

        if (sessionUser && shouldIgnoreExisting) {
          console.log(
            "[AuthProvider] ignoring anonymous session during OAuth",
            sessionUser.id
          );
        }

        if (pendingOAuth) {
          console.log("[AuthProvider] awaiting Supabase session after OAuth…");
          const pendingTokens = readPendingTokens();
          console.log("[AuthProvider] pending tokens read", pendingTokens);
          if (pendingTokens?.access_token && pendingTokens?.refresh_token) {
            try {
              console.log("[AuthProvider] applying pending tokens");
              await supabase.auth.setSession(pendingTokens);
              console.log("[AuthProvider] pending tokens applied, fetching session");
              clearPendingTokens();
              const { data: refreshed } = await supabase.auth.getSession();
              if (refreshed?.session?.user) {
                clearPendingOAuthArtifacts(url);
                if (mounted) {
                  setUser(refreshed.session.user);
                }
                return;
              }
            } catch (tokenErr) {
              console.warn("[AuthProvider] pending token setSession failed", tokenErr);
            }
          } else {
            console.log("[AuthProvider] no pending tokens available");
          }
          const awaited = await waitForSupabaseSession();
          if (awaited?.user) {
            clearPendingOAuthArtifacts(url);
            if (mounted) {
              setUser(awaited.user);
            }
            return;
          }
          console.log("[AuthProvider] extra delay before fallback after OAuth wait");
          await new Promise((res) => setTimeout(res, 1500));
          try {
            const { data: delayedCheck } = await supabase.auth.getSession();
            const delayedUser = delayedCheck?.session?.user || null;
            if (delayedUser && !isAnonymous(delayedUser)) {
              console.log("[AuthProvider] session became available after delay", delayedUser.id);
              clearPendingOAuthArtifacts(url);
              if (mounted) setUser(delayedUser);
              return;
            }
          } catch (delayErr) {
            console.warn("[AuthProvider] delayed session check failed", delayErr);
          }
          console.warn("[AuthProvider] session still missing after OAuth wait, continuing.");
          clearPendingOAuthArtifacts(url);
        }

        const onCallback = onAuthCallbackPath();
        const cameFromCallback = lastRoute === "/auth/callback";
        console.log("[AuthProvider] route states", {
          onCallback,
          lastRoute,
          cameFromCallback,
          path: window.location.pathname,
        });

        if (!onCallback && !cameFromCallback) {
          console.log("[AuthProvider] no session, creating anonymous user");
          await new Promise((res) => setTimeout(res, 1200));
          const { data: lateSession } = await supabase.auth.getSession();
          if (lateSession?.session?.user && !isAnonymous(lateSession.session.user)) {
            console.log("[AuthProvider] session appeared before anonymous fallback", lateSession.session.user.id);
            clearPendingOAuthArtifacts(url);
            if (mounted) setUser(lateSession.session.user);
          } else {
            const { data: anonRes, error: anonErr } =
              await supabase.auth.signInAnonymously();
            if (anonErr) {
              console.error("[Auth] Anonymous sign-in failed:", anonErr);
              if (mounted) setUser(null);
              return;
            }
            if (mounted) {
              setPendingOAuthState(null);
              clearPendingTokens();
              console.log("[AuthProvider] anonymous user ready", anonRes?.user?.id);
              setUser(anonRes?.user ?? null);
            }
          }
        } else {
          console.log("[AuthProvider] skipping anonymous session (on or from callback)");
        }
      } finally {
        if (mounted) {
          setReady(true);
          console.log("[AuthProvider] bootstrap complete");
        }
      }
    }

    ensureSession();

    const { data: listener } = supabase.auth.onAuthStateChange((evt, session) => {
      console.log("[AuthProvider] onAuthStateChange", evt, session?.user?.id);
      if (mounted) setUser(session?.user ?? null);
    });

    return () => {
      mounted = false;
      listener?.subscription?.unsubscribe?.();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 2) One-time adopt after login (fallback when callback didn't have ?guest=)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !user) return;
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(LAST_VISITED_ROUTE_KEY, window.location.pathname);
      console.log("[AuthProvider] stored last route", window.location.pathname);
    } catch (err) {
      console.warn("[AuthProvider] unable to store last route", err);
    }
    const oldId = readGuestId();
    if (!oldId) return;
    if (isAnonymous(user)) return;

    (async () => {
      try {
        console.log("[AuthProvider] post-login adopt_guest start", {
          oldId,
          newUser: user.id,
        });
        const { error } = await supabase.rpc("adopt_guest", {
          p_old_user: oldId,
        });
        if (error) {
          console.warn("adopt_guest (post-login) failed:", error);
          return;
        }
        console.log("[AuthProvider] post-login adopt_guest success");
        clearGuestId();
      } catch (e) {
        console.warn("adopt_guest (post-login) threw:", e);
      }
    })();
  }, [ready, user?.id]);

  // ---------------------------------------------------------------------------
  // 3) Email/password: ALWAYS signUp (so they confirm email)
  // ---------------------------------------------------------------------------
  async function signupOrLink(email, password) {
    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    if (current?.is_anonymous) {
      const oldGuestId = current.id;
      storeGuestId(oldGuestId);
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

  // ---------------------------------------------------------------------------
  // 4) Google sign-in
  // ---------------------------------------------------------------------------
  async function googleSignIn() {
    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    const isGuest = isAnonymous(current);
    const guestId = isGuest ? current?.id ?? null : null;

    if (isGuest && guestId) storeGuestId(guestId);

    const redirectTo = buildRedirectURL(guestId);

    if (typeof window !== "undefined") {
      setPendingOAuthState("starting");
    }

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        queryParams: { prompt: "select_account" },
      },
    });

    if (error) {
      setPendingOAuthState(null);
      console.error("[Auth] googleSignIn error:", error);
      throw error;
    }

    return { started: true };
  }

  // ---------------------------------------------------------------------------
  // 5) Sign out -> start fresh anonymous session again
  // ---------------------------------------------------------------------------
  const signout = async () => {
    setReady(false);
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.error("signOut error:", e);
    }

    try {
      const { data: anonRes, error: anonErr } =
        await supabase.auth.signInAnonymously();
      if (anonErr) {
        console.error(
          "Failed to start anonymous session after sign out:",
          anonErr
        );
      }
      const { data } = await supabase.auth.getUser();
      setUser(data?.user ?? null);
    } finally {
      setReady(true);
    }
  };

  return (
    <AuthCtx.Provider
      value={{
        user,
        ready,
        signupOrLink,
        signin,
        googleSignIn,
        signout,
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
