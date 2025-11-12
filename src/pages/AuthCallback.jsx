// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { storeGuestId } from "../auth/guestStorage";

function isSafariBrowser() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const low = ua.toLowerCase();
  // Desktop Safari (exclude Chrome/CRIOS/Android)
  return low.includes("safari") && !low.includes("chrome") && !low.includes("crios") && !low.includes("android");
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
    console.warn("[AuthCallback] applyHelperFromHash: missing private helpers");
    throw new Error("Supabase client missing internal helper methods.");
  }
  const entries = Object.fromEntries(hashParams.entries());
  console.log("[AuthCallback] applyHelperFromHash entries:", entries);
  const { data, error } = await privGet(entries, "implicit");
  if (error) throw error;
  if (!data?.session?.user) throw new Error("Helper returned no session user.");
  await privSave(data.session);
  await privNotify("SIGNED_IN", data.session);
  console.log("[AuthCallback] helper stored session for", data.session.user.id);
  return data.session.user;
}

function isAnonymousUser(user) {
  if (!user) return false;
  const providers = Array.isArray(user.app_metadata?.providers) ? user.app_metadata.providers : [];
  return (
    user.is_anonymous === true ||
    user.user_metadata?.is_anonymous === true ||
    user.app_metadata?.provider === "anonymous" ||
    providers.includes("anonymous") ||
    (Array.isArray(user.identities) && user.identities.some((i) => i?.provider === "anonymous")) ||
    (!user.email && (providers.length === 0 || providers.includes("anonymous")))
  );
}

function isIgnorableIdentityError(error, desc) {
  const msg = `${error || ""} ${desc || ""}`.toLowerCase();
  return msg.includes("identity") && msg.includes("already") && (msg.includes("linked") || msg.includes("exists"));
}

// Keys used by AuthProvider
const OAUTH_PENDING_KEY = "smartquiz_pending_oauth";
const LAST_VISITED_ROUTE_KEY = "smartquiz_last_route";
const OAUTH_PENDING_TOKENS = "smartquiz_pending_tokens";

function setPendingOAuthState(val) {
  try {
    if (val) sessionStorage.setItem(OAUTH_PENDING_KEY, val);
    else sessionStorage.removeItem(OAUTH_PENDING_KEY);
    console.log("[AuthCallback] setPendingOAuthState:", val);
  } catch {}
}

function storePendingTokens(sessionLike) {
  if (!sessionLike) return;
  const payload = {
    access_token: sessionLike.access_token,
    refresh_token: sessionLike.refresh_token,
    expires_at: sessionLike.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
  };
  try {
    sessionStorage.setItem(OAUTH_PENDING_TOKENS, JSON.stringify(payload));
    console.log("[AuthCallback] storePendingTokens -> saved:", {
      hasAccess: !!payload.access_token,
      hasRefresh: !!payload.refresh_token,
      exp: payload.expires_at,
    });
  } catch {}
}

function createMemoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
}

async function runSafariAutoHandler(hashParams) {
  if (!isSafariBrowser()) return false;
  console.log("[AuthCallback] Safari auto handler: start");
  try {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !key) {
      console.warn("[AuthCallback] Safari auto: missing env URL/KEY");
      return false;
    }
    const helper = createClient(url, key, {
      auth: { detectSessionInUrl: true, persistSession: true, autoRefreshToken: true, storage: createMemoryStorage() },
    });

    // A) Try helper.getSessionFromUrl (if fragment is present)
    if (typeof helper.auth.getSessionFromUrl === "function") {
      console.log("[AuthCallback] Safari auto: helper.getSessionFromUrl");
      const { data, error } = await helper.auth.getSessionFromUrl({ storeSession: true });
      if (!error && data?.session?.user) {
        const s = data.session;
        await supabase.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
        storePendingTokens(s);
        const { data: post } = await supabase.auth.getUser();
        console.log("[AuthCallback] Safari auto: main client populated via helper");
        return { user: post?.user || s.user, tokens: { access_token: s.access_token, refresh_token: s.refresh_token } };
      }
      if (error) console.warn("[AuthCallback] Safari auto: getSessionFromUrl error", error);
    }

    // B) Fallback: use private helper on main client
    const hasHash = hashParams && Array.from(hashParams.keys()).length > 0;
    if (hasHash) {
      console.log("[AuthCallback] Safari auto: fallback applyHelperFromHash");
      try {
        const helperUser = await applyHelperFromHash(hashParams);
        const { data: after } = await supabase.auth.getSession();
        if (after?.session?.access_token && after?.session?.refresh_token) {
          const s = after.session;
          storePendingTokens(s);
          return { user: helperUser, tokens: { access_token: s.access_token, refresh_token: s.refresh_token } };
        }
      } catch (e) {
        console.warn("[AuthCallback] Safari auto: applyHelperFromHash error", e);
      }
    }

    // C) Last try: check main client
    const { data: main } = await supabase.auth.getSession();
    if (main?.session?.user && main.session.access_token && main.session.refresh_token) {
      const s = main.session;
      storePendingTokens(s);
      return { user: s.user, tokens: { access_token: s.access_token, refresh_token: s.refresh_token } };
    }

    console.warn("[AuthCallback] Safari auto handler: no usable session");
    return false;
  } catch (err) {
    console.warn("[AuthCallback] Safari auto handler failed", err);
    return false;
  }
}

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    if (typeof window === "undefined") return;

    (async () => {
      try {
        const safari = isSafariBrowser();
        const url = new URL(window.location.href);
        const params = url.searchParams;
        const hashParams = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));

        console.log("[AuthCallback] UA:", navigator.userAgent || "");
        console.log("[AuthCallback] isSafariBrowser:", safari);
        console.log("[AuthCallback] location:", url.toString());
        console.log("[AuthCallback] hash keys:", Array.from(hashParams.keys()));

        // ---- SAFARI FAST PATH (EARLY EXIT) -----------------------------------
        // If Safari returned with tokens in the fragment, stash them for AuthProvider
        // and leave /auth/callback immediately so we don't get stuck here.
        if (safari) {
          const a = hashParams.get("access_token");
          const r = hashParams.get("refresh_token");
          const exp = Number(hashParams.get("expires_at")) || Math.floor(Date.now() / 1000) + 3600;

          if (a && r) {
            console.log("[AuthCallback] SAFARI FAST PATH: found tokens in hash; stashing + hard redirect");
            storePendingTokens({ access_token: a, refresh_token: r, expires_at: exp });
            try {
              sessionStorage.setItem(LAST_VISITED_ROUTE_KEY, "/auth/callback");
              setPendingOAuthState("returning");
            } catch {}
            setMsg("Signed in. Redirecting…");
            // hard navigation so SPA doesn't keep us on /auth/callback
            window.location.replace("/?source=safari-fast");
            return;
          }
        }
        // ----------------------------------------------------------------------

        // Normal error handling (shared)
        const error = params.get("error") || hashParams.get("error") || null;
        const errorDesc = params.get("error_description") || hashParams.get("error_description") || "";
        if (error && !isIgnorableIdentityError(error, errorDesc)) {
          const readable = `Auth error: ${error}${errorDesc ? ` — ${decodeURIComponent(errorDesc)}` : ""}`;
          console.error("[AuthCallback]", readable);
          setMsg(readable);
          return;
        } else if (error) {
          console.log("[AuthCallback] ignorable identity error:", error, errorDesc);
          setMsg("That Google account is already linked. Signing you into it now…");
        }

        const guestParam = params.get("guest");
        if (guestParam) {
          console.log("[AuthCallback] preserving guest id", guestParam);
          storeGuestId(guestParam);
        }

        const finishWithUser = async (user, source = "unknown", fallbackTokens = null) => {
          if (!user) return false;
          console.log("[AuthCallback] finishWithUser: user", user.id, "source:", source);

          const { data: current } = await supabase.auth.getSession();
          if (current?.session?.access_token && current?.session?.refresh_token) {
            storePendingTokens(current.session);
          } else if (fallbackTokens?.access_token && fallbackTokens?.refresh_token) {
            storePendingTokens(fallbackTokens);
          }

          try {
            sessionStorage.setItem(LAST_VISITED_ROUTE_KEY, "/auth/callback");
            setPendingOAuthState("returning");
          } catch {}

          setMsg("Signed in. Redirecting…");
          if (isSafariBrowser()) {
            window.location.replace("/?source=finish");
          } else {
            window.history.replaceState({}, document.title, "/");
            nav("/", { replace: true });
          }
          return true;
        };

        // Safari helper (only if fast path didn’t run)
        let safariResult = null;
        if (safari) {
          safariResult = await runSafariAutoHandler(hashParams);
          console.log("[AuthCallback] runSafariAutoHandler:", {
            hasUser: !!safariResult?.user,
            hasTokens: !!safariResult?.tokens?.access_token && !!safariResult?.tokens?.refresh_token,
            userId: safariResult?.user?.id || null,
          });
          if (safariResult?.user) {
            if (await finishWithUser(safariResult.user, "safari-auto-handler", safariResult.tokens)) return;
          }
        }

        // ---- Chrome/general flows (UNCHANGED) --------------------------------
        const code = params.get("code") || params.get("token") || params.get("auth_code") || null;
        const a2 = hashParams.get("access_token");
        const r2 = hashParams.get("refresh_token");
        const hasImplicitTokens = !!a2 && !!r2;

        console.log("[AuthCallback] parsed params", { codePresent: !!code, hasImplicitTokens });

        if (code) {
          console.log("[AuthCallback] exchanging code via Supabase");
          setMsg("Finishing sign-in…");
          const { error: exchErr } = await supabase.auth.exchangeCodeForSession(code);
          if (exchErr) {
            console.error("[AuthCallback] exchangeCodeForSession error:", exchErr);
            setMsg(exchErr.message || "Could not finish sign-in.");
            return;
          }
          const { data: u } = await supabase.auth.getUser();
          if (await finishWithUser(u?.user ?? null, "code-exchange")) return;
        } else if (hasImplicitTokens) {
          console.log("[AuthCallback] implicit tokens detected (non-safari)");
          setMsg("Finishing sign-in…");
          try {
            let helperUser = null;
            try {
              console.log("[AuthCallback] using helper for implicit tokens");
              helperUser = await applyHelperFromHash(hashParams);
              if (await finishWithUser(helperUser, "implicit-helper", { access_token: a2, refresh_token: r2 })) return;
            } catch (helperErr) {
              console.warn("[AuthCallback] helper failed, trying setSession", helperErr);
              await supabase.auth.setSession({ access_token: a2, refresh_token: r2 });
              const { data: u2 } = await supabase.auth.getUser();
              if (await finishWithUser(u2?.user ?? null, "setSession-fallback", { access_token: a2, refresh_token: r2 })) return;
            }
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
          if (await finishWithUser(data.session.user, "existing-session")) return;
        }
        // ----------------------------------------------------------------------

        // Final small wait loop (unchanged behavior)
        const waitMs = 1000;
        const deadline = Date.now() + 8000;
        let authedUser = (await supabase.auth.getUser())?.data?.user || null;
        while (Date.now() < deadline && !authedUser) {
          const { data: s, error } = await supabase.auth.getSession();
          if (error) {
            console.warn("[AuthCallback] getSession error while waiting", error);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          authedUser = s?.session?.user || null;
          console.log("[AuthCallback] waiting for user →", authedUser?.id || null);
          if (!authedUser) await new Promise((r) => setTimeout(r, waitMs));
        }
        if (authedUser) {
          if (await finishWithUser(authedUser, "retry-loop-final")) return;
        }

        console.error("[AuthCallback] No session user after retries");
        setMsg("Signed in, but Safari didn’t finish loading your account. Refresh this tab.");
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