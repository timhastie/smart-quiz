// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { storeGuestId } from "../auth/guestStorage";

function normalizeError(searchParams) {
  const error = searchParams.get("error");
  const errorDesc = searchParams.get("error_description") || "";
  return { error, errorDesc };
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

    const url = new URL(window.location.href);
    const { error, errorDesc } = normalizeError(url.searchParams);

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

    const guestFromQuery = url.searchParams.get("guest");
    if (guestFromQuery) {
      storeGuestId(guestFromQuery);
    }

    let active = true;

    async function checkExistingSession() {
      const { data, error: sessionErr } = await supabase.auth.getSession();
      if (!active) return;
      if (sessionErr) {
        console.error("[AuthCallback] getSession error:", sessionErr);
        setMsg(sessionErr.message || "Could not finish sign-in.");
        return;
      }
      if (data?.session?.user) {
        setMsg("Signed in. Redirecting…");
        window.history.replaceState({}, document.title, "/");
        nav("/", { replace: true });
      }
    }

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (!active) return;
        if (event === "SIGNED_IN" && session?.user) {
            setMsg("Signed in. Redirecting…");
            window.history.replaceState({}, document.title, "/");
            nav("/", { replace: true });
        } else if (event === "SIGNED_OUT") {
          setMsg("Sign-in was cancelled. You can close this tab.");
        }
      }
    );

    checkExistingSession();

    return () => {
      active = false;
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
