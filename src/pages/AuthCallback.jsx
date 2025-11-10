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

        if (!code && !hashRefreshToken) {
          const dbg = `[AuthCallback] Missing auth code or tokens in ${url.toString()}`;
          console.error(dbg);
          setMsg("Missing auth code.");
          alert("Missing auth code — see console for details.");
          return;
        }

        if (code) {
          console.log("[AuthCallback] Exchanging PKCE code for session…");
          const pkceTimeout = setTimeout(() => {
            console.warn("[AuthCallback] exchangeCodeForSession still pending after 8s");
            setMsg("Still finishing sign-in…");
          }, 8000);

          const { error: exchErr } = await supabase.auth.exchangeCodeForSession(code);
          clearTimeout(pkceTimeout);
          if (exchErr) {
            console.error("[AuthCallback] exchangeCodeForSession error:", exchErr);
            setMsg(exchErr.message || "Could not finish sign-in.");
            alert(exchErr.message || "Could not finish sign-in.");
            return;
          }
          console.log("[AuthCallback] exchangeCodeForSession succeeded");
        } else {
          console.log(
            "[AuthCallback] Using refreshSession for hash tokens",
            JSON.stringify({
              hasAccess: Boolean(hashAccessToken),
              hasRefresh: Boolean(hashRefreshToken),
            })
          );
          const refreshTimeout = setTimeout(() => {
            console.warn("[AuthCallback] refreshSession still pending after 8s");
            setMsg("Still finishing sign-in…");
          }, 8000);

          const { data: refreshData, error: refreshErr } = await supabase.auth.refreshSession({
            refresh_token: hashRefreshToken,
          });
          clearTimeout(refreshTimeout);

          if (refreshErr) {
            console.error("[AuthCallback] refreshSession error:", refreshErr);
            setMsg(refreshErr.message || "Could not finish sign-in.");
            alert(refreshErr.message || "Could not finish sign-in.");
            return;
          }

          if (!refreshData?.session?.user) {
            console.error("[AuthCallback] refreshSession returned no user", refreshData);
            setMsg("No session returned. Please try again.");
            alert("Finished sign-in but no session was returned. Please try again.");
            return;
          }

          console.log(
            "[AuthCallback] refreshSession succeeded for user:",
            refreshData.session.user.id
          );
        }

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
