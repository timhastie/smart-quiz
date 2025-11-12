// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { clearGuestId, readGuestId, storeGuestId } from "../auth/guestStorage";

function isSafariBrowser() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes("safari") && !ua.includes("chrome") && !ua.includes("android");
}

async function applyHelperFromHash(hashParams) {
  const privGet =
    typeof supabase.auth._getSessionFromURL === "function"
      ? supabase.auth._getSessionFromURL.bind(supabase.auth)
      : null;
  const privSave =
    typeof supabase.auth._saveSession === "function"
      ? supabase.auth._saveSession.bind(supabase.auth)
      : null;
  const privNotify =
    typeof supabase.auth._notifyAllSubscribers === "function"
      ? supabase.auth._notifyAllSubscribers.bind(supabase.auth)
      : null;
  if (!privGet || !privSave || !privNotify) {
    throw new Error("Supabase client missing internal helper methods.");
  }
  const implicitEntries = Object.fromEntries(hashParams.entries());
  console.log("[AuthCallback] applying helper from hash entries");
  const { data, error } = await privGet(implicitEntries, "implicit");
  if (error) throw error;
  if (!data?.session?.user) {
    throw new Error("Helper returned no session user.");
  }
  await privSave(data.session);
  await privNotify("SIGNED_IN", data.session);
  console.log("[AuthCallback] helper stored session for", data.session.user.id);
  return data.session.user;
}

function isAnonymousUser(user) {
  if (!user) return false;
  const providers = Array.isArray(user.app_metadata?.providers)
    ? user.app_metadata.providers
    : [];
  return (
    user.is_anonymous === true ||
    user.user_metadata?.is_anonymous === true ||
    user.app_metadata?.provider === "anonymous" ||
    providers.includes("anonymous") ||
    (Array.isArray(user.identities) &&
      user.identities.some((i) => i?.provider === "anonymous")) ||
    (!user.email && (providers.length === 0 || providers.includes("anonymous")))
  );
}

function isIgnorableIdentityError(error, desc) {
  const msg = `${error || ""} ${desc || ""}`.toLowerCase();
  return (
    msg.includes("identity") &&
    msg.includes("already") &&
    (msg.includes("linked") || msg.includes("exists"))
  );
}

const OAUTH_PENDING_KEY = "smartquiz_pending_oauth";
const LAST_VISITED_ROUTE_KEY = "smartquiz_last_route";
const SAFARI_HELPER_FLAG = "smartquiz_safari_helper";
const OAUTH_PENDING_TOKENS = "smartquiz_pending_tokens";
function setPendingOAuthState(value) {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.sessionStorage.setItem(OAUTH_PENDING_KEY, value);
    } else {
      window.sessionStorage.removeItem(OAUTH_PENDING_KEY);
    }
  } catch {
    /* ignore */
  }
}

function storePendingTokens(session) {
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
}

function createMemoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

async function runSafariAutoHandler(hashParams) {
  if (!isSafariBrowser()) return false;
  try {
    console.log("[AuthCallback] Safari auto handler starting");
    const flag = window.sessionStorage.getItem(SAFARI_HELPER_FLAG);
    if (flag === "done") return false;
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !key) return false;
    const helperClient = createClient(url, key, {
      auth: {
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
        storage: createMemoryStorage(),
      },
    });
    let helperSession = null;
    if (typeof helperClient.auth.getSessionFromUrl === "function") {
      const { data, error: helperErr } = await helperClient.auth.getSessionFromUrl({
        storeSession: true,
      });
      if (helperErr) {
        console.warn("[AuthCallback] helper client getSessionFromUrl error", helperErr);
      } else {
        helperSession = data?.session || null;
      }
    }

    if (!helperSession && hashParams?.toString()) {
      console.log("[AuthCallback] Safari helper falling back to hash parsing");
      const helperUser = await applyHelperFromHash(hashParams);
      const { data: refreshed } = await helperClient.auth.getSession();
      helperSession = refreshed?.session || {
        user: helperUser,
        access_token: hashParams.get("access_token"),
        refresh_token: hashParams.get("refresh_token"),
      };
    }

    if (helperSession?.access_token && helperSession?.refresh_token) {
      await supabase.auth.setSession({
        access_token: helperSession.access_token,
        refresh_token: helperSession.refresh_token,
      });
      storePendingTokens(helperSession);
      const { data: postUser } = await supabase.auth.getUser();
      window.sessionStorage.setItem(SAFARI_HELPER_FLAG, "done");
      console.log("[AuthCallback] Safari auto handler populated session");
      return {
        user: postUser?.user || helperSession.user || null,
        tokens: {
          access_token: helperSession.access_token,
          refresh_token: helperSession.refresh_token,
        },
      };
    }
  } catch (err) {
    console.warn("[AuthCallback] Safari auto handler failed", err);
  }
  console.warn("[AuthCallback] Safari auto handler found no session");
  return false;
}

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Completing sign-in…");

  const attemptSetSession = async (tokens) => {
    if (!tokens?.access_token || !tokens?.refresh_token) {
      throw new Error("attemptSetSession called without tokens");
    }
    console.log("[AuthCallback] attempting supabase.auth.setSession");
    const timeoutMs = 5000;
    let timeoutId;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("setSession timeout"));
        }, timeoutMs);
      });
      const result = await Promise.race([
        supabase.auth.setSession(tokens),
        timeoutPromise,
      ]);
      clearTimeout(timeoutId);
      console.log("[AuthCallback] setSession resolved", result?.error || "ok");
      if (result?.error) throw result.error;
      return true;
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn("[AuthCallback] setSession did not succeed:", err);
      throw err;
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    (async () => {
      try {
        const url = new URL(window.location.href);
        const params = url.searchParams;
        const hashParams = new URLSearchParams(
          (window.location.hash || "").replace(/^#/, "")
        );
        let safariResult = null;
        if (isSafariBrowser()) {
          safariResult = await runSafariAutoHandler(hashParams);
        }

        console.log("[AuthCallback] location", url.toString());

        const error =
          params.get("error") || hashParams.get("error") || null;
        const errorDesc =
          params.get("error_description") ||
          hashParams.get("error_description") ||
          "";

        if (error && !isIgnorableIdentityError(error, errorDesc)) {
          const readable = `Auth error: ${error}${
            errorDesc ? ` — ${decodeURIComponent(errorDesc)}` : ""
          }`;
          console.error("[AuthCallback]", readable);
          setMsg(readable);
          return;
        } else if (error) {
          setMsg(
            "That Google account is already linked. Signing you into it now…"
          );
        }

        const guestParam = params.get("guest");
        if (guestParam) storeGuestId(guestParam);
        const finishWithUser = async (user, sourceLabel = "unknown", fallbackTokens = null) => {
          if (!user) return false;
          console.log("[AuthCallback] session user available:", user.id, "via", sourceLabel);
          setMsg("Signed in. Redirecting…");
          const { data: currentSession } = await supabase.auth.getSession();
          if (currentSession?.session?.access_token && currentSession?.session?.refresh_token) {
            storePendingTokens(currentSession.session);
            console.log("[AuthCallback] stored pending tokens for", user.id, "from Supabase session");
          } else if (fallbackTokens?.access_token && fallbackTokens?.refresh_token) {
            storePendingTokens(fallbackTokens);
            console.log("[AuthCallback] stored fallback tokens for", user.id);
          }
          setPendingOAuthState("returning");
          try {
            window.sessionStorage.setItem(LAST_VISITED_ROUTE_KEY, "/auth/callback");
          } catch {
            /* ignore */
          }
          const safari = isSafariBrowser();
          if (safari) {
            console.log("[AuthCallback] Safari session captured; forcing reload");
            window.location.replace("/");
          } else {
            window.history.replaceState({}, document.title, "/");
            nav("/", { replace: true });
          }
          return true;
        };

        if (safariResult?.user) {
          if (
            await finishWithUser(
              safariResult.user,
              "safari-auto-handler",
              safariResult.tokens
            )
          )
            return;
        }

        const code =
          params.get("code") ||
          params.get("token") ||
          params.get("auth_code") ||
          null;
        const accessToken = hashParams.get("access_token");
        const refreshToken = hashParams.get("refresh_token");
        const hasImplicitTokens = accessToken && refreshToken;
        console.log("[AuthCallback] parsed params", {
          codePresent: Boolean(code),
          hasImplicitTokens,
          guest: guestParam || null,
        });

        let helperUsed = false;

        if (code) {
          console.log("[AuthCallback] exchanging code via Supabase");
          setMsg("Finishing sign-in…");
          const { error: exchErr } = await supabase.auth.exchangeCodeForSession(
            code
          );
          if (exchErr) {
            console.error("[AuthCallback] exchangeCodeForSession error:", exchErr);
            setMsg(exchErr.message || "Could not finish sign-in.");
            return;
          }
          const { data: userAfterCode } = await supabase.auth.getUser();
          if (await finishWithUser(userAfterCode?.user ?? null)) return;
        } else if (hasImplicitTokens) {
          console.log("[AuthCallback] implicit tokens detected");
          setMsg("Finishing sign-in…");
          try {
            let helperUser = null;
            try {
              console.log("[AuthCallback] using helper for implicit tokens");
              helperUser = await applyHelperFromHash(hashParams);
              helperUsed = true;
              if (
                await finishWithUser(helperUser, "implicit-helper", {
                  access_token: accessToken,
                  refresh_token: refreshToken,
                })
              )
                return;
            } catch (helperErr) {
              console.warn("[AuthCallback] helper failed, trying setSession", helperErr);
              await attemptSetSession({
                access_token: accessToken,
                refresh_token: refreshToken,
              });
            }
            const { data: userAfterImplicit } = await supabase.auth.getUser();
            if (
              await finishWithUser(
                userAfterImplicit?.user ?? null,
                "getUser-after-implicit",
                {
                  access_token: accessToken,
                  refresh_token: refreshToken,
                }
              )
            )
              return;
          } catch (implicitErr) {
            console.error("[AuthCallback] implicit helper flow failed:", implicitErr);
            setMsg(implicitErr.message || "Could not finish sign-in.");
            return;
          }
        } else {
          console.log("[AuthCallback] no code/hash tokens, checking existing session");
          const { data } = await supabase.auth.getSession();
          if (!data?.session?.user) {
            console.error("[AuthCallback] Missing auth code/tokens.");
            setMsg("Missing auth code in callback. Please try again.");
            return;
          }
        }

        const waitMs = 1500;
        const deadline = Date.now() + 12000; // wait up to 12s for Safari to persist session
        let authedUser = null;
        const { data: immediateUser } = await supabase.auth.getUser();
        authedUser = immediateUser?.user || null;
        let lastErr = null;
        while (Date.now() < deadline && !authedUser) {
          const { data: finalSession, error: finalErr } =
            await supabase.auth.getSession();
          if (finalErr) {
            lastErr = finalErr;
            console.warn("[AuthCallback] getSession error while waiting", finalErr);
            await new Promise((res) => setTimeout(res, waitMs));
            continue;
          }
          authedUser = finalSession?.session?.user || null;
          if (!authedUser) {
            if (!helperUsed && !isSafariBrowser()) {
              console.warn("[AuthCallback] still no user; applying helper fallback");
              const helperUser = await applyHelperFromHash(hashParams);
              if (
                await finishWithUser(helperUser, "helper-from-retry-loop", {
                  access_token: hashParams.get("access_token"),
                  refresh_token: hashParams.get("refresh_token"),
                })
              )
                return;
              helperUsed = true;
            }
            await new Promise((res) => setTimeout(res, waitMs));
          }
        }
        if (authedUser) {
          if (
            await finishWithUser(authedUser, "retry-loop-final", {
              access_token: hashParams.get("access_token") || null,
              refresh_token: hashParams.get("refresh_token") || null,
            })
          ) {
            return;
          }
        }
        if (!authedUser) {
          console.error("[AuthCallback] No session user after retries", lastErr);
          setMsg(
            "Signed in, but Safari didn’t finish loading your account. Refresh this tab."
          );
          return;
        }
        await finishWithUser(authedUser);
      } catch (err) {
        console.error("[AuthCallback] Unexpected error:", err);
        setMsg(err?.message || "Unexpected error finishing sign-in.");
      }
    })();
  }, [nav]);

  return (
    <div className="min-h-screen grid place-items-center bg-slate-950 text-slate-100 px-4 py-10">
      <div className="px-6 py-4 rounded-2xl bg-slate-900/80 border border-slate-700/70 max-w-xl text-center text-lg">
        {msg}
      </div>
    </div>
  );
}
