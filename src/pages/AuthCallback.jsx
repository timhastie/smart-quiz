// src/pages/AuthCallback.jsx
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

const GUEST_STORAGE_KEY = "guest_to_merge";

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
  const adoptedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let active = true;

    const url = new URL(window.location.href);
    const error = url.searchParams.get("error");
    const errorDesc = url.searchParams.get("error_description") || "";
    const ignorable = isIgnorableIdentityError(error, errorDesc);

    if (error && !ignorable) {
      const readable = `Auth error: ${error}${
        errorDesc ? ` — ${decodeURIComponent(errorDesc)}` : ""
      }`;
      console.error("[AuthCallback]", readable);
      setMsg(readable);
      return;
    }

    if (ignorable) {
      setMsg(
        "This Google account was already linked. Finishing sign-in and moving your quizzes…"
      );
    }

    const guestParam = url.searchParams.get("guest") || "";

    async function adoptIfNeeded(sessionUser) {
      if (!sessionUser || adoptedRef.current) return;

      const localGuest =
        typeof window !== "undefined"
          ? window.localStorage.getItem(GUEST_STORAGE_KEY) || ""
          : "";
      const guestToAdopt = guestParam || localGuest;

      if (
        guestToAdopt &&
        !isAnonymousUser(sessionUser) &&
        guestToAdopt !== sessionUser.id
      ) {
        adoptedRef.current = true;
        setMsg("Moving your quizzes to this account…");
        try {
          const { error: adoptErr } = await supabase.rpc("adopt_guest", {
            p_old_user: guestToAdopt,
          });
          if (adoptErr) {
            console.warn("[AuthCallback] adopt_guest error:", adoptErr);
          } else if (typeof window !== "undefined") {
            window.localStorage.removeItem(GUEST_STORAGE_KEY);
          }
        } catch (adoptError) {
          console.warn("[AuthCallback] adopt_guest threw:", adoptError);
        }
      }
    }

    function redirectHome() {
      if (!active) return;
      window.history.replaceState({}, document.title, "/");
      nav("/", { replace: true });
    }

    async function finalize(session) {
      if (!active || !session?.user) return;
      await adoptIfNeeded(session.user);
      setMsg("Signed in. Redirecting…");
      redirectHome();
    }

    const timeout = window.setTimeout(() => {
      if (!active) return;
      setMsg("Still finishing sign-in…");
    }, 7000);

    (async () => {
      const { data, error: sessionErr } = await supabase.auth.getSession();
      if (!active) return;
      if (sessionErr) {
        console.error("[AuthCallback] getSession error:", sessionErr);
        setMsg(sessionErr.message || "Could not finish sign-in.");
        window.clearTimeout(timeout);
        return;
      }
      if (data?.session?.user) {
        window.clearTimeout(timeout);
        await finalize(data.session);
      }
    })();

    const { data: subscription } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (!active) return;
        if (event === "SIGNED_IN") {
          window.clearTimeout(timeout);
          await finalize(session);
        } else if (event === "SIGNED_OUT") {
          setMsg("Sign-in was cancelled. You can close this tab.");
        }
      }
    );

    return () => {
      active = false;
      window.clearTimeout(timeout);
      subscription?.subscription?.unsubscribe();
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
