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
            "[AuthCallback] Using implicit flow helper",
            JSON.stringify({
              hasAccess: Boolean(hashAccessToken),
              hasRefresh: Boolean(hashRefreshToken),
            })
          );

          const privateGet =
            typeof supabase.auth._getSessionFromURL === "function"
              ? supabase.auth._getSessionFromURL.bind(supabase.auth)
              : null;
          const privateSave =
            typeof supabase.auth._saveSession === "function"
              ? supabase.auth._saveSession.bind(supabase.auth)
              : null;
          const privateNotify =
            typeof supabase.auth._notifyAllSubscribers === "function"
              ? supabase.auth._notifyAllSubscribers.bind(supabase.auth)
              : null;

          if (!privateGet || !privateSave || !privateNotify) {
            console.error("[AuthCallback] Supabase client missing internal helpers");
            setMsg("Could not finish sign-in (client mismatch).");
            alert("Could not finish sign-in. Please refresh and try again.");
            return;
          }

          const implicitParams = Object.fromEntries(hashParams.entries());
          const implicitTimeout = setTimeout(() => {
            console.warn("[AuthCallback] implicit helper still pending after 8s");
            setMsg("Still finishing sign-in…");
          }, 8000);

          const { data: implicitData, error: implicitErr } = await privateGet(
            implicitParams,
            "implicit"
          );
          clearTimeout(implicitTimeout);

          if (implicitErr) {
            console.error("[AuthCallback] implicit helper error:", implicitErr);
            setMsg(implicitErr.message || "Could not finish sign-in.");
            alert(implicitErr.message || "Could not finish sign-in.");
            return;
          }

          const session = implicitData?.session;
          if (!session?.user) {
            console.error("[AuthCallback] implicit helper returned no user", implicitData);
            setMsg("No session returned. Please try again.");
            alert("Finished sign-in but no session was returned. Please try again.");
            return;
          }

          await privateSave(session);
          await privateNotify("SIGNED_IN", session);
          console.log("[AuthCallback] implicit helper stored session for user:", session.user.id);
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
