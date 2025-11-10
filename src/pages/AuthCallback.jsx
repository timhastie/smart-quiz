import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

// DEBUG: expose client for console tests (safe in dev)
if (typeof window !== "undefined") window.__sb = supabase;

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    (async () => {
      try {
        const url = new URL(window.location.href);
        const error = url.searchParams.get("error");
        const errorDesc = url.searchParams.get("error_description");
        console.log("[AuthCallback] URL params:", Object.fromEntries(url.searchParams.entries()));

        if (error) {
          const diagnostic = `Auth error: ${error}${errorDesc ? ` — ${errorDesc}` : ""}`;
          setMsg(diagnostic);
          console.error("[AuthCallback] Supabase error:", {
            error,
            errorDesc,
            fullUrl: url.toString(),
          });
          alert(diagnostic);
          return;
        }

        console.log("[AuthCallback] Calling getSessionFromUrl …");
        const timeout = setTimeout(() => {
          console.error("[AuthCallback] getSessionFromUrl timeout after 8s");
          setMsg("Timed out finishing sign-in.");
          alert("Timed out finishing sign-in. Please try again.");
        }, 8000);

        try {
          const { data, error: sessionErr } = await supabase.auth.getSessionFromUrl({
            storeSession: true,
          });
          clearTimeout(timeout);
          if (sessionErr) {
            console.error("[AuthCallback] getSessionFromUrl error:", sessionErr);
            setMsg(sessionErr.message || "Could not finish sign-in.");
            alert(sessionErr.message || "Could not finish sign-in.");
            return;
          }
          console.log("[AuthCallback] getSessionFromUrl data:", data);
          window.history.replaceState({}, document.title, window.location.pathname);
        } catch (err) {
          clearTimeout(timeout);
          console.error("[AuthCallback] getSessionFromUrl threw:", err);
          setMsg(err.message || "Could not finish sign-in.");
          alert(err.message || "Could not finish sign-in.");
          return;
        }

        setMsg("Signed in. Redirecting…");
        console.log("[AuthCallback] Redirecting home…");
        // 3) Redirect home (or change to your preferred landing page)
        nav("/", { replace: true });
      } catch (e) {
        console.error(e);
        setMsg("Unexpected error finishing sign-in.");
      }
    })();
  }, [nav]);

  return (
    <div className="min-h-screen grid place-items-center px-4 py-10 text-slate-100">
      <div className="surface-card p-6 sm:p-7 text-center text-white/80 max-w-md">{msg}</div>
    </div>
  );
}
