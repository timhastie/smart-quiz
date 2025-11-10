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
        const params = url.searchParams;
        const hash = window.location.hash || "";
        const hashParams = new URLSearchParams(
          hash.startsWith("#") ? hash.slice(1) : hash
        );

        console.log("[AuthCallback] URL params:", Object.fromEntries(params.entries()));
        console.log("[AuthCallback] Hash params:", Object.fromEntries(hashParams.entries()));

        const error = params.get("error") || hashParams.get("error");
        const errorDesc =
          params.get("error_description") || hashParams.get("error_description");

        if (error) {
          const diagnostic = `Auth error: ${error}${
            errorDesc ? ` — ${errorDesc}` : ""
          }`;
          console.error("[AuthCallback]", diagnostic);
          setMsg(diagnostic);
          return;
        }

        const code = params.get("code");

        if (code) {
          // ---------- PKCE FLOW ----------
          setMsg("Finishing sign-in…");
          console.log("[AuthCallback] Exchanging PKCE code for session…");

          const { data, error: exchErr } =
            await supabase.auth.exchangeCodeForSession(code);

          if (exchErr) {
            console.error("[AuthCallback] exchangeCodeForSession error:", exchErr);
            setMsg(
              exchErr.message || "Could not finish sign-in. Please try again."
            );
            return;
          }

          console.log(
            "[AuthCallback] PKCE exchange succeeded for user:",
            data?.session?.user?.id
          );
        } else {
          // ---------- FALLBACK: IMPLICIT TOKENS (if any) ----------
          const access_token = hashParams.get("access_token");
          const refresh_token = hashParams.get("refresh_token");

          if (access_token && refresh_token) {
            setMsg("Finishing sign-in…");
            console.log(
              "[AuthCallback] Using implicit tokens from hash to set session"
            );

            const { data, error: setErr } = await supabase.auth.setSession({
              access_token,
              refresh_token,
            });

            if (setErr) {
              console.error("[AuthCallback] setSession error:", setErr);
              setMsg(
                setErr.message ||
                  "Could not finish sign-in. Please try again."
              );
              return;
            }

            console.log(
              "[AuthCallback] Implicit session stored for user:",
              data?.session?.user?.id
            );
          } else {
            console.error(
              "[AuthCallback] Missing auth code and no usable tokens in hash"
            );
            setMsg("Missing auth code in callback. Please try again.");
            return;
          }
        }

        // ---------- SUCCESS: clean URL + go home ----------
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
