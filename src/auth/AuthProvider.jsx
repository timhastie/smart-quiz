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
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {}
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
  } catch {}
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
  } catch {}
};

function clearPendingOAuthArtifacts(url) {
  setPendingOAuthState(null);
  clearPendingTokens();
  try {
    sessionStorage.removeItem(LAST_VISITED_ROUTE_KEY);
  } catch {}
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
    console.log("[AuthProvider] waiting for Supabase session… attempt", attempt, "remaining", `${remaining}ms`);
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  console.warn("[AuthProvider] waitForSupabaseSession timed out");
  return null;
}

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

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

function isAnonymous(u) {
  if (!u) return false;
  const prov = u.app_metadata?.provider || null;
  const provs = Array.isArray(u.app_metadata?.providers) ? u.app_metadata.providers : [];
  return (
    u.is_anonymous === true ||
    u.user_metadata?.is_anonymous === true ||
    prov === "anonymous" ||
    provs.includes("anonymous") ||
    (Array.isArray(u.identities) && u.identities.some((i) => i?.provider === "anonymous")) ||
    (!u.email && (provs.length === 0 || provs.includes("anonymous")))
  );
}

/* ----------------------- OAuth adoption (Safari-safe) ---------------------- */
// returns { adopted: boolean, user: SupabaseUser|null }
function clearOAuthReturnFlags() {
  try {
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
    sessionStorage.removeItem(LAST_VISITED_ROUTE_KEY);
    sessionStorage.removeItem(OAUTH_PENDING_TOKENS);
  } catch {}
}

async function adoptOAuthIfPending(supabaseClient) {
  const last = sessionStorage.getItem(LAST_VISITED_ROUTE_KEY);
  const pending = sessionStorage.getItem(OAUTH_PENDING_KEY);
  const tokens0 = readPendingTokens();

  console.log("[AuthProvider] adoptOAuthIfPending check →", {
    last,
    pending,
    hasTokens: !!(tokens0?.access_token && tokens0?.refresh_token),
  });

  if (last !== "/auth/callback" && pending !== "returning") {
    return { adopted: false, user: null };
  }

  let tokens = tokens0;
  if (!tokens?.access_token || !tokens?.refresh_token) {
    console.log("[AuthProvider] adoptOAuthIfPending: waiting 200ms for tokens to flush…");
    await new Promise((r) => setTimeout(r, 200));
    tokens = readPendingTokens();
  }
  if (!tokens?.access_token || !tokens?.refresh_token) {
    console.warn("[AuthProvider] adoptOAuthIfPending → no tokens found");
    return { adopted: false, user: null };
  }

  console.log("[AuthProvider] adopting OAuth session via setSession()");
  const { error } = await supabaseClient.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  if (error) console.warn("[AuthProvider] setSession error during adoption:", error);

  // Poll *immediately* for a real user; Safari sometimes lags.
  const deadline = Date.now() + 6000;
  let poll = 0;
  let u = null;
  while (Date.now() < deadline && !u) {
    poll++;
    const { data } = await supabaseClient.auth.getSession();
    u = data?.session?.user || null;
    console.log("[AuthProvider] adopt poll", poll, "user:", u?.id || null);
    if (!u) await new Promise((r) => setTimeout(r, 250));
  }

  // Clear flags no matter what so we don’t loop forever
  clearOAuthReturnFlags();
  console.log("[AuthProvider] adoption complete, flags cleared; user:", u?.id || null);

  return { adopted: true, user: u };
}
/* -------------------------------------------------------------------------- */

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // Bootstrap
  useEffect(() => {
    let mounted = true;

    async function ensureSession() {
      try {
        const url = new URL(window.location.href);
        console.log("[AuthProvider] bootstrap start, path:", window.location.pathname);

        // ***** EARLY BARRIER: adopt OAuth BEFORE any anon *****
        const adoptResult = await adoptOAuthIfPending(supabase);
        if (adoptResult.adopted) {
          if (adoptResult.user) {
            console.log("[AuthProvider] early-adopt SUCCESS →", adoptResult.user.id);
            if (mounted) {
              clearPendingOAuthArtifacts(url);
              setUser(adoptResult.user);
              setReady(true);
              return;
            }
          } else {
            console.log("[AuthProvider] early-adopt had no user yet; entering wait loop");
            const sess = await waitForSupabaseSession(8000, 300);
            if (sess?.user && mounted) {
              clearPendingOAuthArtifacts(url);
              setUser(sess.user);
              setReady(true);
              return;
            }
            console.warn("[AuthProvider] early-adopt still no user; continue bootstrap WITHOUT anon creation (to avoid clobber).");
          }
        }
        // ********************************************************

        let lastRoute = null;
        try {
          lastRoute = window.sessionStorage.getItem(LAST_VISITED_ROUTE_KEY);
          console.log("[AuthProvider] last recorded route", lastRoute);
        } catch (err) {
          console.warn("[AuthProvider] unable to read last route", err);
        }

        let pendingOAuth = getPendingOAuthState();
        if (!pendingOAuth && hasCookieFlag()) pendingOAuth = "cookie";
        const fromAuthParam = url.searchParams.get("from") === "auth";
        if (!pendingOAuth && fromAuthParam) {
          console.log("[AuthProvider] pending OAuth inferred from URL");
          pendingOAuth = "from-url";
        }
        if (pendingOAuth) console.log("[AuthProvider] pending OAuth detected via", pendingOAuth);

        let sessionUser = null;
        let shouldIgnoreExisting = false;
        const guestId = readGuestId();
        try {
          const { data: sess, error } = await supabase.auth.getSession();
          if (error) console.error("[Auth] getSession error:", error);
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
          setReady(true);
          return;
        }

        if (sessionUser && shouldIgnoreExisting) {
          console.log("[AuthProvider] ignoring anonymous session during OAuth", sessionUser.id);
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
                  setReady(true);
                }
                return;
              }
            } catch (tokenErr) {
              console.warn("[AuthProvider] pending token setSession failed", tokenErr);
            }
          } else {
            console.log("[AuthProvider] no pending tokens available");
          }

          const awaited = await waitForSupabaseSession(8000, 300);
          if (awaited?.user) {
            clearPendingOAuthArtifacts(url);
            if (mounted) {
              setUser(awaited.user);
              setReady(true);
            }
            return;
          }

          console.warn("[AuthProvider] session still missing after OAuth wait, continuing (no anon here).");
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

        // Only auto-create anon when NOT on/after callback
        if (!onCallback && !cameFromCallback) {
          console.log("[AuthProvider] no session, creating anonymous user");
          await new Promise((res) => setTimeout(res, 1200)); // small grace for Safari
          const { data: lateSession } = await supabase.auth.getSession();
          if (lateSession?.session?.user && !isAnonymous(lateSession.session.user)) {
            console.log("[AuthProvider] session appeared before anonymous fallback", lateSession.session.user.id);
            clearPendingOAuthArtifacts(url);
            if (mounted) setUser(lateSession.session.user);
          } else {
            const { data: anonRes, error: anonErr } = await supabase.auth.signInAnonymously();
            if (anonErr) {
              console.error("[Auth] Anonymous sign-in failed:", anonErr);
              if (mounted) setUser(null);
              setReady(true);
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
      setUser(session?.user ?? null);
    });

    return () => {
      listener?.subscription?.unsubscribe?.();
    };
  }, []);

  // Post-login adopt_guest
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
        console.log("[AuthProvider] post-login adopt_guest start", { oldId, newUser: user.id });
        const { error } = await supabase.rpc("adopt_guest", { p_old_user: oldId });
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

  async function signupOrLink(email, password) {
    const { data: { user: current } = {} } = await supabase.auth.getUser();

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

  async function googleSignIn() {
    const { data: { user: current } = {} } = await supabase.auth.getUser();
    const isGuest = isAnonymous(current);
    const guestId = isGuest ? current?.id ?? null : null;
    if (isGuest && guestId) storeGuestId(guestId);
    const redirectTo = buildRedirectURL(guestId);
    if (typeof window !== "undefined") setPendingOAuthState("starting");

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo, queryParams: { prompt: "select_account" } },
    });

    if (error) {
      setPendingOAuthState(null);
      console.error("[Auth] googleSignIn error:", error);
      throw error;
    }
    return { started: true };
  }

  const signout = async () => {
    setReady(false);
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.error("signOut error:", e);
    }

    try {
      const { data: anonRes, error: anonErr } = await supabase.auth.signInAnonymously();
      if (anonErr) console.error("Failed to start anonymous session after sign out:", anonErr);
      const { data } = await supabase.auth.getUser();
      setUser(data?.user ?? null);
    } finally {
      setReady(true);
    }
  };

  return (
    <AuthCtx.Provider
      value={{ user, ready, signupOrLink, signin, googleSignIn, signout }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
