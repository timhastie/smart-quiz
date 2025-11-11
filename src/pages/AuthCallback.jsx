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

    let cancelled = false;
    let unsub = null;

    const finishWithUser = async (user) => {
      if (!user || cancelled) return false;
      console.log("[AuthCallback] session user available:", user.id);
      const guestId = readGuestId();
      if (guestId && guestId !== user.id && !isAnonymousUser(user)) {
        setMsg("Moving your quizzes to this account…");
        try {
          const { error } = await supabase.rpc("adopt_guest", {
            p_old_user: guestId,
          });
          if (error) {
            console.warn("[AuthCallback] adopt_guest error:", error);
          } else {
            clearGuestId();
          }
        } catch (err) {
          console.warn("[AuthCallback] adopt_guest threw:", err);
        }
      }
      setMsg("Signed in. Redirecting…");
      window.history.replaceState({}, document.title, "/");
      nav("/", { replace: true });
      return true;
    };

    const run = async () => {
      const url = new URL(window.location.href);
      const params = url.searchParams;
      const hashParams = new URLSearchParams(
        (window.location.hash || "").replace(/^#/, "")
      );

      console.log("[AuthCallback] location", url.toString());

      const error = params.get("error") || hashParams.get("error") || null;
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
        setMsg("That Google account is already linked. Signing you into it now…");
      }

      const guestParam = params.get("guest");
      if (guestParam) storeGuestId(guestParam);

      try {
        const { data, error: sessionErr } = await supabase.auth.getSessionFromUrl({
          storeSession: true,
        });
        if (cancelled) return;
        if (sessionErr && !isIgnorableIdentityError(sessionErr.message)) {
          console.error("[AuthCallback] getSessionFromUrl error:", sessionErr);
          setMsg(sessionErr.message || "Could not finish sign-in.");
          return;
        }
        const sessionUser = data?.session?.user;
        if (sessionUser && (await finishWithUser(sessionUser))) {
          return;
        }
      } catch (err) {
        console.error("[AuthCallback] getSessionFromUrl threw:", err);
      }

      setMsg("Signed in. Finalizing session…");
      unsub = supabase.auth.onAuthStateChange((_event, session) => {
        if (session?.user) {
          finishWithUser(session.user);
        }
      });
    };

    run();

    return () => {
      cancelled = true;
      unsub?.data?.subscription?.unsubscribe?.();
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
