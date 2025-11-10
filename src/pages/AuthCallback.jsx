import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    if (typeof window === "undefined") return;
    let active = true;

    const search = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(
      (window.location.hash || "").replace(/^#/, "")
    );
    const error = search.get("error") || hashParams.get("error");
    const errorDesc =
      search.get("error_description") || hashParams.get("error_description");

    if (error && active) {
      setMsg(
        `Auth error: ${error}${errorDesc ? ` — ${errorDesc}` : ""}. You can close this tab.`
      );
      return () => {
        active = false;
      };
    }

    function redirectHome() {
      if (!active) return;
      window.history.replaceState({}, document.title, "/");
      nav("/", { replace: true });
    }

    async function checkExistingSession() {
      try {
        const { data, error: sessionErr } = await supabase.auth.getSession();
        if (!active) return;
        if (sessionErr) {
          console.error("[AuthCallback] getSession error:", sessionErr);
          setMsg(sessionErr.message || "Could not finish sign-in.");
          return;
        }
        if (data?.session?.user) {
          setMsg("Signed in. Redirecting…");
          redirectHome();
        } else {
          setMsg("Completing sign-in…");
        }
      } catch (e) {
        if (!active) return;
        console.error("[AuthCallback] getSession threw:", e);
        setMsg(e?.message || "Unexpected error completing sign-in.");
      }
    }

    const { data: listener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (!active) return;
        console.log("[AuthCallback] auth event:", event, session?.user?.id || null);
        if (event === "SIGNED_IN" && session?.user) {
          setMsg("Signed in. Redirecting…");
          redirectHome();
        } else if (event === "SIGNED_OUT") {
          setMsg("Sign-in canceled. You can close this tab.");
        }
      }
    );

    const timeoutId = window.setTimeout(() => {
      if (!active) return;
      setMsg(
        "Still finishing sign-in… If this hangs, close this tab and reopen the app."
      );
    }, 8000);

    checkExistingSession();

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
      listener?.subscription?.unsubscribe();
    };
  }, [nav]);

  return (
    <div className="min-h-screen grid place-items-center px-4 py-10 text-slate-100">
      <div className="surface-card p-6 sm:p-7 text-center text-white/80 max-w-md">
        {msg}
      </div>
    </div>
  );
}
