// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

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

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    let cancelled = false;

    async function handleCallback() {
      try {
        if (typeof window === "undefined") return;

        const url = new URL(window.location.href);
        const searchParams = url.searchParams;
        const hashParams = new URLSearchParams(
          (window.location.hash || "").replace(/^#/, "")
        );

        const combinedError = `${searchParams.get("error") || ""} ${
          searchParams.get("error_description") || ""
        } ${hashParams.get("error") || ""} ${
          hashParams.get("error_description") || ""
        }`.toLowerCase();
        const identityAlreadyLinked =
          combinedError.includes("identity") &&
          combinedError.includes("already") &&
          combinedError.includes("linked");

        if (!identityAlreadyLinked) {
          const error =
            searchParams.get("error") || hashParams.get("error") || null;
          const errorDesc =
            searchParams.get("error_description") ||
            hashParams.get("error_description") ||
            "";

          if (error) {
            const readable = `Auth error: ${error}${
              errorDesc ? ` — ${decodeURIComponent(errorDesc)}` : ""
            }`;
            console.error("[AuthCallback] OAuth error:", readable);
            if (!cancelled) setMsg(readable);
            return;
          }
        } else {
          console.warn(
            "[AuthCallback] Identity already linked message present; continuing with fallback session."
          );
        }

        const code =
          searchParams.get("code") ||
          searchParams.get("token") ||
          searchParams.get("auth_code") ||
          null;
        const accessToken = hashParams.get("access_token");
        const refreshToken = hashParams.get("refresh_token");
        const hasImplicitTokens = accessToken && refreshToken;

        if (code) {
          console.log("[AuthCallback] Exchanging PKCE code for session…");
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            console.error("[AuthCallback] exchangeCodeForSession error:", error);
            if (!cancelled)
              setMsg(error.message || "Could not finish sign-in.");
            return;
          }
        } else if (hasImplicitTokens) {
          console.log("[AuthCallback] Building session from implicit tokens.");
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
            console.error(
              "[AuthCallback] Supabase helpers missing for implicit flow."
            );
            if (!cancelled)
              setMsg("Could not finish sign-in (client mismatch).");
            return;
          }

          const { data, error } = await privGet(
            Object.fromEntries(hashParams.entries()),
            "implicit"
          );
          if (error) {
            console.error("[AuthCallback] implicit helper error:", error);
            if (!cancelled)
              setMsg(error.message || "Could not finish sign-in.");
            return;
          }

          const session = data?.session;
          if (!session?.user) {
            console.error("[AuthCallback] implicit helper returned no user", data);
            if (!cancelled)
              setMsg("No session returned. Please try again.");
            return;
          }

          await privSave(session);
          await privNotify("SIGNED_IN", session);
          console.log(
            "[AuthCallback] implicit session stored for user:",
            session.user.id
          );
        } else {
          console.log(
            "[AuthCallback] No code/hash tokens; checking if session already exists."
          );
          const { data } = await supabase.auth.getSession();
          if (!data?.session?.user) {
            console.error("[AuthCallback] No session found after redirect.");
            if (!cancelled)
              setMsg("Missing auth code in callback. Please try again.");
            return;
          }
        }

        const { data: finalSession, error: finalErr } =
          await supabase.auth.getSession();
        if (finalErr) {
          console.error("[AuthCallback] final getSession error:", finalErr);
          if (!cancelled)
            setMsg(finalErr.message || "Could not finish sign-in.");
          return;
        }

        const user = finalSession?.session?.user;
        if (!user) {
          console.error("[AuthCallback] Session established but no user found.");
          if (!cancelled)
            setMsg("Signed in, but we could not load your account.");
          return;
        }

        const guestFromQuery = searchParams.get("guest");
        let guestToAdopt = guestFromQuery || "";
        if (!guestToAdopt && typeof window !== "undefined") {
          guestToAdopt = window.localStorage.getItem("guest_to_adopt") || "";
        }

        if (guestToAdopt && !isAnonymousUser(user) && guestToAdopt !== user.id) {
          console.log("[AuthCallback] Running adopt_guest", {
            from: guestToAdopt,
            to: user.id,
          });
          if (!cancelled) setMsg("Moving your quizzes to this account…");
          try {
            const { error } = await supabase.rpc("adopt_guest", {
              p_old_user: guestToAdopt,
            });
            if (error) {
              console.warn("[AuthCallback] adopt_guest error:", error);
            } else if (typeof window !== "undefined") {
              window.localStorage.removeItem("guest_to_adopt");
            }
          } catch (adoptErr) {
            console.warn("[AuthCallback] adopt_guest threw:", adoptErr);
          }
        }

        if (!cancelled) {
          setMsg("Signed in. Redirecting…");
          window.history.replaceState({}, document.title, "/");
          nav("/", { replace: true });
        }
      } catch (err) {
        console.error("[AuthCallback] Unexpected error:", err);
        if (!cancelled)
          setMsg(err?.message || "Unexpected error finishing sign-in.");
      }
    }

    handleCallback();

    return () => {
      cancelled = true;
    };
  }, [nav]);

  return (
    <div className="min-h-screen grid place-items-center bg-slate-950 text-slate-100 px-4 py-10">
      <div className="px-6 py-4 rounded-2xl bg-slate-900/80 border border-slate-700/70 max-w-xl text-center text-lg">
        {msg}
      </div>
    </div>
  );
}
