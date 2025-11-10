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
        // Supabase v2 sends ?code=... but on implicit flow we get hash tokens
        const code =
          url.searchParams.get("code") ||
          url.searchParams.get("token") ||
          url.searchParams.get("auth_code");
        const hashParams = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
        const hashAccessToken = hashParams.get("access_token");
        const hashRefreshToken = hashParams.get("refresh_token");

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
        if (!code && !(hashAccessToken && hashRefreshToken)) {
          const dbg = `[AuthCallback] Missing auth code in ${url.toString()}`;
          console.error(dbg);
          setMsg("Missing auth code.");
          alert("Missing auth code — see console for details.");
          return;
        }

        if (code) {
          const { error: exchErr } = await supabase.auth.exchangeCodeForSession(code);
          if (exchErr) {
            console.error("[AuthCallback] exchangeCodeForSession error:", exchErr);
            setMsg(exchErr.message || "Could not finish sign-in.");
            return;
          }
        } else {
          console.log("[AuthCallback] Using implicit tokens from hash.");
          const { data: setData, error: setErr } = await supabase.auth.setSession({
            access_token: hashAccessToken,
            refresh_token: hashRefreshToken,
          });
          if (setErr) {
            console.error("[AuthCallback] setSession error:", setErr);
            setMsg(setErr.message || "Could not finish sign-in.");
            return;
          }
          console.log("[AuthCallback] setSession succeeded:", setData);
          const { data: sessionCheck } = await supabase.auth.getSession();
          console.log("[AuthCallback] getSession after setSession:", sessionCheck);
          window.history.replaceState({}, document.title, window.location.pathname);
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
