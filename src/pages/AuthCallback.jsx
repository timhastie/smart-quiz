import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Finishing sign-in...");
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      try {
        const url = new URL(window.location.href);
        const params = url.searchParams;
        const hash = new URLSearchParams(
          (window.location.hash || "").replace(/^#/, "")
        );

        console.log("[AuthCallback] URL params:", Object.fromEntries(params.entries()));
        console.log("[AuthCallback] Hash params:", Object.fromEntries(hash.entries()));

        const error = params.get("error");
        const errorDesc = params.get("error_description");

        if (error) {
          const diagnostic = `Auth error: ${error}${
            errorDesc ? ` — ${errorDesc}` : ""
          }`;
          console.error("[AuthCallback] Supabase error:", {
            error,
            errorDesc,
            fullUrl: url.toString(),
          });
          setMsg(diagnostic);
          alert(diagnostic);
          return;
        }

        const code = params.get("code");

        if (code) {
          console.log(
            "[AuthCallback] Exchanging PKCE code for session...",
            code
          );

          const { data, error: exchErr } =
            await supabase.auth.exchangeCodeForSession(code);

          if (exchErr) {
            console.error(
              "[AuthCallback] exchangeCodeForSession error:",
              exchErr
            );
            setMsg(exchErr.message || "Could not finish sign-in.");
            alert(exchErr.message || "Could not finish sign-in.");
            return;
          }

          console.log(
            "[AuthCallback] exchangeCodeForSession succeeded",
            data?.session?.user?.id
          );
        } else {
          // No ?code – nothing we can do here with PKCE config
          console.error(
            "[AuthCallback] No auth code found in callback URL"
          );
          setMsg("Missing auth code in callback. Please try again.");
          alert("Missing auth code in callback. Please try again.");
          return;
        }

        // Clean URL so refresh doesn't repeat callback
        window.history.replaceState({}, document.title, "/");

        setMsg("Signed in. Redirecting…");
        nav("/", { replace: true });
      } catch (e) {
        console.error("[AuthCallback] Unexpected error:", e);
        setMsg("Unexpected error finishing sign-in.");
        alert(e?.message || "Unexpected error finishing sign-in.");
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
