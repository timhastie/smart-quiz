import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

// DEBUG: expose client for console tests (safe in dev)
if (typeof window !== "undefined") window.__sb = supabase;

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
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const errorDesc = url.searchParams.get("error_description");
        const hashParams = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
        const hashAccessToken = hashParams.get("access_token");
        const hashRefreshToken = hashParams.get("refresh_token");
        const hashData = Object.fromEntries(hashParams.entries());

        console.log("[AuthCallback] URL params:", Object.fromEntries(url.searchParams.entries()));
        console.log("[AuthCallback] Hash params:", hashData);

        // Persist a quick snapshot so we can manually inspect it from DevTools later.
        try {
          localStorage.setItem(
            "last_auth_hash",
            JSON.stringify({ ts: Date.now(), hash: hashData, code: Boolean(code) })
          );
        } catch {}

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
          const dbg = `[AuthCallback] Missing auth code or tokens in ${url.toString()}`;
          console.error(dbg);
          setMsg("Missing auth code.");
          alert("Missing auth code — see console for details.");
          return;
        }

        console.log(
          "[AuthCallback] Starting getSessionFromUrl",
          JSON.stringify({ hasCode: Boolean(code), hasHashAccess: Boolean(hashAccessToken) })
        );

        const waitWarn = setTimeout(() => {
          console.warn("[AuthCallback] getSessionFromUrl still pending after 8s");
          setMsg("Still finishing sign-in…");
        }, 8000);

        const { data, error: sessionErr } = await supabase.auth.getSessionFromUrl({
          storeSession: true,
        });
        clearTimeout(waitWarn);

        if (sessionErr) {
          console.error("[AuthCallback] getSessionFromUrl error:", sessionErr);
          setMsg(sessionErr.message || "Could not finish sign-in.");
          alert(sessionErr.message || "Could not finish sign-in.");
          return;
        }

        if (!data?.session?.user) {
          console.error("[AuthCallback] No user returned from getSessionFromUrl", data);
          setMsg("No session returned. Please try again.");
          alert("Finished sign-in but no session was returned. Please try again.");
          return;
        }

        console.log("[AuthCallback] Session established for user:", data.session.user.id);

        // Clean up the URL so refreshes don’t retry the callback flow.
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
      <div className="surface-card p-6 sm:p-7 text-center text-white/80 max-w-md">{msg}</div>
    </div>
  );
}
