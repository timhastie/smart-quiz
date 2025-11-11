// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { clearGuestId, readGuestId, storeGuestId } from "../auth/guestStorage";

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

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    if (typeof window === "undefined") return;

    (async () => {
      try {
        const url = new URL(window.location.href);
        const params = url.searchParams;
        const hashParams = new URLSearchParams(
          (window.location.hash || "").replace(/^#/, "")
        );
        const hashEntries = Object.fromEntries(hashParams.entries());

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

        console.log("[AuthCallback] raw params", {
          codePresent: Boolean(params.get("code")),
          hasHashTokens: hasImplicitTokens,
          guest: params.get("guest") || null,
        });

        const guestParam = params.get("guest");
        if (guestParam) storeGuestId(guestParam);

        const code =
          params.get("code") ||
          params.get("token") ||
          params.get("auth_code") ||
          null;
        const accessToken = hashParams.get("access_token");
        const refreshToken = hashParams.get("refresh_token");
        const hasImplicitTokens = accessToken && refreshToken;

        if (code) {
          console.log("[AuthCallback] exchanging code via Supabase");
          setMsg("Finishing sign-in…");
          const timeout = setTimeout(() => {
            console.warn("[AuthCallback] exchangeCodeForSession taking >8s");
          }, 8000);
          const { error: exchErr } = await supabase.auth.exchangeCodeForSession(
            code
          );
          clearTimeout(timeout);
          if (exchErr) {
            console.error("[AuthCallback] exchangeCodeForSession error:", exchErr);
            setMsg(exchErr.message || "Could not finish sign-in.");
            return;
          }
        } else if (hasImplicitTokens) {
          console.log("[AuthCallback] using implicit flow helpers");
          setMsg("Finishing sign-in…");
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
            console.error("[AuthCallback] Supabase helpers missing.");
            setMsg("Could not finish sign-in (client mismatch).");
            return;
          }

          const { data, error: implicitErr } = await privGet(
            hashEntries,
            "implicit"
          );
          if (implicitErr) {
            console.error("[AuthCallback] implicit helper error:", implicitErr);
            setMsg(implicitErr.message || "Could not finish sign-in.");
            return;
          }
          const session = data?.session;
          if (!session?.user) {
            console.error("[AuthCallback] implicit helper returned no user", data);
            setMsg("No session returned. Please try again.");
            return;
          }
          await privSave(session);
          await privNotify("SIGNED_IN", session);
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
        const deadline = Date.now() + 10000; // wait up to 10s for Safari to persist session
        let authedUser = null;
        let lastErr = null;
        while (Date.now() < deadline && !authedUser) {
          const { data: finalSession, error: finalErr } =
            await supabase.auth.getSession();
          if (finalErr) {
            lastErr = finalErr;
            await new Promise((res) => setTimeout(res, waitMs));
            continue;
          }
          authedUser = finalSession?.session?.user || null;
          if (!authedUser) {
            await new Promise((res) => setTimeout(res, waitMs));
          }
        }
        if (!authedUser) {
          console.error("[AuthCallback] No session user after retries", lastErr);
          setMsg(
            "Signed in, but Safari didn’t finish loading your account. Refresh this tab."
          );
          return;
        }
        console.log("[AuthCallback] session user available:", authedUser.id);

        const guestId = readGuestId();
        if (guestId && guestId !== authedUser.id && !isAnonymousUser(authedUser)) {
          setMsg("Moving your quizzes to this account…");
          try {
            const { error: adoptErr } = await supabase.rpc("adopt_guest", {
              p_old_user: guestId,
            });
            if (adoptErr) {
              console.warn("[AuthCallback] adopt_guest error:", adoptErr);
            } else {
              clearGuestId();
            }
          } catch (adoptError) {
            console.warn("[AuthCallback] adopt_guest threw:", adoptError);
          }
        }

        setMsg("Signed in. Redirecting…");
        console.log("[AuthCallback] redirecting to /");
        window.history.replaceState({}, document.title, "/");
        setTimeout(() => {
          window.location.href = "/";
        }, 100);
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
