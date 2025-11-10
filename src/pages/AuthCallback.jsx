import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export default function AuthCallback() {
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    let canceled = false;

    async function finishSignIn() {
      try {
        if (typeof window === "undefined") return;

        const url = new URL(window.location.href);
        const params = Object.fromEntries(url.searchParams.entries());
        const hashParams = new URLSearchParams(
          (window.location.hash || "").replace(/^#/, "")
        );
        const hashObj = Object.fromEntries(hashParams.entries());

        console.log("[AuthCallback] URL params:", params);
        console.log("[AuthCallback] Hash params:", hashObj);

        const error =
          params.error || hashParams.get("error") || null;
        const errorDesc =
          params.error_description || hashParams.get("error_description") || null;

        if (error) {
          const diagnostic = `Auth error: ${error}${
            errorDesc ? ` — ${errorDesc}` : ""
          }`;
          console.error("[AuthCallback]", diagnostic);
          if (!canceled) setMsg(diagnostic);
          return;
        }

        const code = params.code || null;
        const accessToken = hashParams.get("access_token");
        const refreshToken = hashParams.get("refresh_token");

        if (!code && !(accessToken && refreshToken)) {
          console.error("[AuthCallback] Missing code/tokens in callback URL.");
          if (!canceled)
            setMsg("Missing auth code in callback. Please try again.");
          return;
        }

        if (code) {
          console.log("[AuthCallback] Exchanging PKCE code for session…");
          const timeout = setTimeout(() => {
            if (!canceled)
              console.warn("[AuthCallback] exchangeCodeForSession taking >8s");
          }, 8000);
          const { error: exchErr } = await supabase.auth.exchangeCodeForSession(
            code
          );
          clearTimeout(timeout);
          if (exchErr) {
            console.error(
              "[AuthCallback] exchangeCodeForSession error:",
              exchErr
            );
            if (!canceled)
              setMsg(exchErr.message || "Could not finish sign-in.");
            return;
          }
        } else if (accessToken && refreshToken) {
          console.log("[AuthCallback] Using implicit tokens from URL hash");
          const timeout = setTimeout(() => {
            if (!canceled)
              console.warn("[AuthCallback] setSession taking >8s (implicit)");
          }, 8000);
          const { error: sessionErr } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          clearTimeout(timeout);
          if (sessionErr) {
            console.error("[AuthCallback] setSession error:", sessionErr);
            if (!canceled)
              setMsg(sessionErr.message || "Could not finish sign-in.");
            return;
          }
        }

        const { data } = await supabase.auth.getSession();
        console.log(
          "[AuthCallback] Session after processing:",
          data?.session?.user?.id || null
        );

        if (!canceled) {
          setMsg("Signed in. Redirecting…");
          window.history.replaceState({}, document.title, "/");
          window.location.replace("/");
        }
      } catch (e) {
        console.error("[AuthCallback] Unexpected error:", e);
        if (!canceled)
          setMsg(e?.message || "Unexpected error finishing sign-in.");
      }
    }

    finishSignIn();

    return () => {
      canceled = true;
    };
  }, []);

  return (
    <div className="min-h-screen grid place-items-center px-4 py-10 text-slate-100">
      <div className="surface-card p-6 sm:p-7 text-center text-white/80 max-w-md">
        {msg}
      </div>
    </div>
  );
}
