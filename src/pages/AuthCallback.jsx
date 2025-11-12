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
  return low.includes("safari") && !low.includes("chrome") && !low.includes("crios") && !low.includes("android");
}

// ---- shared keys used by AuthProvider
const OAUTH_PENDING_KEY = "smartquiz_pending_oauth";
const LAST_VISITED_ROUTE_KEY = "smartquiz_last_route";
const OAUTH_PENDING_TOKENS = "smartquiz_pending_tokens";
const OAUTH_PENDING_COOKIE = "smartquiz_auth_pending=1"; // AuthProvider uses this name

function setPendingOAuthState(val) {
  try {
    if (val) {
      sessionStorage.setItem(OAUTH_PENDING_KEY, val);
      localStorage.setItem(OAUTH_PENDING_KEY, val); // redundancy for Safari
      // mirror the cookie the provider checks
      const base = OAUTH_PENDING_COOKIE;
      document.cookie = `${base}; Path=/; Max-Age=60; SameSite=Lax`;
    } else {
      sessionStorage.removeItem(OAUTH_PENDING_KEY);
      localStorage.removeItem(OAUTH_PENDING_KEY);
      const base = OAUTH_PENDING_COOKIE.split("=")[0] + "=";
      document.cookie = `${base}; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
    }
    console.log("[AuthCallback] setPendingOAuthState:", val);
  } catch {}
}

function storePendingTokensMulti(sessionLike) {
  if (!sessionLike) return;
  const payload = {
    access_token: sessionLike.access_token,
    refresh_token: sessionLike.refresh_token,
    expires_at: sessionLike.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
  };
  try {
    const json = JSON.stringify(payload);
    sessionStorage.setItem(OAUTH_PENDING_TOKENS, json);
    localStorage.setItem(OAUTH_PENDING_TOKENS, json); // redundancy for Safari
    console.log("[AuthCallback] storePendingTokensMulti -> saved (both stores):", {
      hasAccess: !!payload.access_token,
      hasRefresh: !!payload.refresh_token,
      exp: payload.expires_at,
    });
  } catch (e) {
    console.warn("[AuthCallback] storePendingTokensMulti failed", e);
  }
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
  if (!privGet || !privSave || !privNotify) throw new Error("Supabase client missing internal helper methods.");

  const entries = Object.fromEntries(hashParams.entries());
  console.log("[AuthCallback] applyHelperFromHash entries:", entries);
  const { data, error } = await privGet(entries, "implicit");
  if (error) throw error;
  if (!data?.session?.user) throw new Error("Helper returned no session user.");
  await privSave(data.session);
  await privNotify("SIGNED_IN", data.session);
  console.log("[AuthCallback] helper stored session for", data.session.user.id);
  return data.session;
}

function isIgnorableIdentityError(error, desc) {
  const msg = `${error || ""} ${desc || ""}`.toLowerCase();
  return msg.includes("identity") && msg.includes("already") && (msg.includes("linked") || msg.includes("exists"));
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

        // ======================= SAFARI FAST PATH (improved) =======================
        if (safari) {
          const access_token = hashParams.get("access_token");
          const refresh_token = hashParams.get("refresh_token");
          const expires_at = Number(hashParams.get("expires_at")) || Math.floor(Date.now() / 1000) + 3600;

          if (access_token && refresh_token) {
            console.log("[AuthCallback] SAFARI FAST PATH: tokens found; setSession + stash + delayed redirect");

            // 1) Immediately set the session on the main client
            try {
              const r = await supabase.auth.setSession({ access_token, refresh_token });
              console.log("[AuthCallback] supabase.auth.setSession result:", r?.error || "ok");
            } catch (e) {
              console.warn("[AuthCallback] setSession threw:", e);
            }

            // 2) Save tokens for AuthProvider (both storages) & mark pending oauth
            storePendingTokensMulti({ access_token, refresh_token, expires_at });
            try {
              sessionStorage.setItem(LAST_VISITED_ROUTE_KEY, "/auth/callback");
            } catch {}
            setPendingOAuthState("returning");

            setMsg("Signed in. Redirecting…");

            // 3) Give Safari a moment to flush storage before leaving the page
            await new Promise((res) => setTimeout(res, 250));

            // 4) Hard redirect off /auth/callback to avoid anon bootstrap
            window.location.replace("/?source=safari-fast2");

            // 5) Failsafe: if somehow still here, try again shortly
            setTimeout(() => {
              if (location.pathname.startsWith("/auth/callback")) {
                console.warn("[AuthCallback] Safari failsafe fired; still on /auth/callback → forcing again");
                window.location.replace("/?source=safari-fallback");
              }
            }, 1200);

            return; // stop here (Safari only)
          }
        }
        // ==========================================================================

        // ---- Safari helper (only runs if fast path didn't) ----
        if (safari) {
          try {
            const session = await applyHelperFromHash(hashParams); // may throw if no hash
            if (session?.access_token && session?.refresh_token) {
              storePendingTokensMulti(session);
              try {
                sessionStorage.setItem(LAST_VISITED_ROUTE_KEY, "/auth/callback");
              } catch {}
              setPendingOAuthState("returning");
              setMsg("Signed in. Redirecting…");
              await new Promise((res) => setTimeout(res, 200));
              window.location.replace("/?source=safari-helper");
              return;
            }
          } catch (e) {
            console.log("[AuthCallback] Safari helper skipped/failed:", e?.message || e);
          }
        }

        // ------------------- Chrome/general flows (unchanged) -------------------
        const code = params.get("code") || params.get("token") || params.get("auth_code") || null;
        const a2 = hashParams.get("access_token");
        const r2 = hashParams.get("refresh_token");
        const hasImplicitTokens = !!a2 && !!r2;
        console.log("[AuthCallback] parsed params", { codePresent: !!code, hasImplicitTokens });

        const finishWithUser = async (source = "unknown") => {
          try {
            sessionStorage.setItem(LAST_VISITED_ROUTE_KEY, "/auth/callback");
          } catch {}
          setPendingOAuthState("returning");
          setMsg("Signed in. Redirecting…");
          window.history.replaceState({}, document.title, "/");
          nav("/", { replace: true });
          return true;
        };

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
          if (u?.user) return finishWithUser("code-exchange");
        } else if (hasImplicitTokens) {
          console.log("[AuthCallback] implicit tokens detected (non-Safari)");
          setMsg("Finishing sign-in…");
          try {
            await supabase.auth.setSession({ access_token: a2, refresh_token: r2 });
            const { data: u2 } = await supabase.auth.getUser();
            if (u2?.user) return finishWithUser("implicit-setSession");
          } catch (e) {
            console.warn("[AuthCallback] implicit setSession failed", e);
            setMsg(e?.message || "Could not finish sign-in.");
            return;
          }
        } else {
          console.log("[AuthCallback] no code/hash tokens, checking existing session");
          const { data } = await supabase.auth.getSession();
          if (data?.session?.user) return finishWithUser("existing-session");
          console.error("[AuthCallback] Missing auth code/tokens.");
          setMsg("Missing auth code in callback. Please try again.");
          return;
        }

        // Final small wait loop (unchanged spirit)
        const waitMs = 800;
        const deadline = Date.now() + 8000;
        let authedUser = (await supabase.auth.getUser())?.data?.user || null;
        while (Date.now() < deadline && !authedUser) {
          const { data: s } = await supabase.auth.getSession();
          authedUser = s?.session?.user || null;
          console.log("[AuthCallback] waiting for user →", authedUser?.id || null);
          if (!authedUser) await new Promise((r) => setTimeout(r, waitMs));
        }
        if (authedUser) return finishWithUser("retry-loop-final");

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
