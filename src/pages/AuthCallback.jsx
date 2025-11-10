// src/auth/AuthCallback.jsx
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Completing sign-in…");
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      try {
        const url = new URL(window.location.href);
        const error = url.searchParams.get("error");
        const errorDesc = url.searchParams.get("error_description");
        const code = url.searchParams.get("code");

        console.log("[AuthCallback] URL params:", Object.fromEntries(url.searchParams.entries()));

        if (error) {
          const diagnostic = `Auth error: ${error}${
            errorDesc ? ` — ${errorDesc}` : ""
          }`;
          console.error("[AuthCallback]", diagnostic);
          setMsg(diagnostic);
          return;
        }

        if (!code) {
          console.error("[AuthCallback] Missing ?code in callback URL");
          setMsg("Missing auth code in callback. Please try again.");
          return;
        }

        setMsg("Finishing sign-in…");

        const { error: exchErr } = await supabase.auth.exchangeCodeForSession(code);

        if (exchErr) {
          console.error("[AuthCallback] exchangeCodeForSession error:", exchErr);
          setMsg(exchErr.message || "Could not finish sign-in. Please try again.");
          return;
        }

        console.log("[AuthCallback] exchangeCodeForSession succeeded");

        // Clean URL so refresh doesn’t repeat the flow
        window.history.replaceState({}, document.title, "/");

        setMsg("Signed in. Redirecting…");
        nav("/", { replace: true });
      } catch (e) {
        console.error("[AuthCallback] Unexpected error:", e);
        setMsg("Unexpected error finishing sign-in. Please try again.");
      }
    })();
  }, [nav]);

  return (
    <div className="min-h-screen grid place-items-center px-4 py-10 text-slate-100">
      <div className="surface-card p-6 sm:p-7 text-center text-white/80 max-w-md">
        {msg}
      </div>
    </div>
  );
}
