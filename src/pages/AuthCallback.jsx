// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { clearGuestId, readGuestId, storeGuestId } from "../auth/guestStorage";

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

function isSafariBrowser() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes("safari") && !ua.includes("chrome") && !ua.includes("android");
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
        const finishWithUser = async (user) => {
          if (!user) return false;
          console.log("[AuthCallback] session user available:", user.id);
          const guestId = readGuestId();
          if (
            guestId &&
            guestId !== user.id &&
            !isAnonymousUser(user)
          ) {
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
          window.history.replaceState({}, document.title, "/");
          nav("/", { replace: true });
          return true;
        };

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
            if (isSafariBrowser()) {
              helperUser = await applyHelperFromHash(hashParams);
              helperUsed = true;
              if (await finishWithUser(helperUser)) return;
            } else {
              const { error: setErr } = await supabase.auth.setSession({
                access_token: accessToken,
                refresh_token: refreshToken,
              });
              if (setErr) {
                console.warn("[AuthCallback] setSession failed, falling back to helper", setErr);
                helperUser = await applyHelperFromHash(hashParams);
                helperUsed = true;
                if (await finishWithUser(helperUser)) return;
              }
            }
            const { data: userAfterImplicit } = await supabase.auth.getUser();
            if (await finishWithUser(userAfterImplicit?.user ?? null)) return;
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
            await new Promise((res) => setTimeout(res, waitMs));
            continue;
          }
          authedUser = finalSession?.session?.user || null;
          if (!authedUser) {
              if (!helperUsed && !isSafariBrowser()) {
                console.warn("[AuthCallback] still no user; applying helper fallback");
              const helperUser = await applyHelperFromHash(hashParams);
              if (await finishWithUser(helperUser)) return;
              helperUsed = true;
            }
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
