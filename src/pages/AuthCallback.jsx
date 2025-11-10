// src/pages/AuthCallback.jsx
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

// DEBUG: quick handle for poking in devtools if needed
if (typeof window !== "undefined") {
  window.__sb = supabase;
}

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Finishing sign-in…");
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      try {
        const url = new URL(window.location.href);
        const search = Object.fromEntries(url.searchParams.entries());
        const hashParams = new URLSearchParams(
          (window.location.hash || "").replace(/^#/, "")
        );
        const hash = Object.fromEntries(hashParams.entries());

        console.log("[AuthCallback] URL params:", search);
        console.log("[AuthCallback] Hash params:", hash);

        const error = search.error || hash.error;
        const errorDesc =
          search.error_description || hash.error_description || null;
        const code = search.code || null;

        // Persist a snapshot for debugging if needed
        try {
          localStorage.setItem(
            "last_auth_callback",
            JSON.stringify({
              ts: Date.now(),
              search,
              hash,
              hasCode: !!code,
              hasError: !!error,
            })
          );
        } catch {
          // ignore
        }

        // ---- Handle provider errors ----------------------------------------
        if (error) {
          const diagnostic = `Auth error: ${error}${
            errorDesc ? ` — ${errorDesc}` : ""
          }`;
          console.error("[AuthCallback] Provider error:", {
            error,
            errorDesc,
            fullUrl: url.toString(),
          });
          setMsg(diagnostic);
          // small delay just so user can read, then send home
          setTimeout(() => nav("/", { replace: true }), 2000);
          return;
        }

        // ---- PKCE code flow ------------------------------------------------
        if (code) {
          console.log(
            "[AuthCallback] Exchanging PKCE code for session…",
            code
          );
          setMsg("Finishing sign-in…");

          let data, exchErr;
          try {
            const res = await supabase.auth.exchangeCodeForSession(code);
            data = res.data;
            exchErr = res.error;
          } catch (e) {
            console.error(
              "[AuthCallback] exchangeCodeForSession threw:",
              e
            );
            exchErr = e;
          }

          if (exchErr) {
            console.error(
              "[AuthCallback] exchangeCodeForSession error:",
              exchErr
            );
            setMsg(
              exchErr.message ||
                "Could not finish sign-in. Please try again."
            );
            // don't leave them stuck on callback URL
            setTimeout(() => nav("/", { replace: true }), 2500);
            return;
          }

          console.log(
            "[AuthCallback] exchangeCodeForSession success:",
            {
              hasSession: !!data?.session,
              userId: data?.session?.user?.id || null,
            }
          );

          // Clean callback cruft from URL so refresh is safe
          window.history.replaceState({}, document.title, "/");

          setMsg("Signed in. Redirecting…");
          nav("/", { replace: true });
          return;
        }

        // ---- Fallback: implicit / hash-based tokens (older flow) ----------
        if (hash.access_token || hash.refresh_token) {
          console.log(
            "[AuthCallback] Detected tokens in hash (implicit/OIDC fallback)"
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
            console.error(
              "[AuthCallback] Missing internal helpers for implicit flow"
            );
            setMsg(
              "Could not finish sign-in (client mismatch). Please try again."
            );
            setTimeout(() => nav("/", { replace: true }), 2500);
            return;
          }

          const implicitParams = Object.fromEntries(hashParams.entries());
          console.log(
            "[AuthCallback] Using implicit tokens from hash to set session…",
            {
              hasAccess: !!implicitParams.access_token,
              hasRefresh: !!implicitParams.refresh_token,
            }
          );

          let implicitData, implicitErr;
          try {
            const res = await privateGet(implicitParams, "implicit");
            implicitData = res.data;
            implicitErr = res.error;
          } catch (e) {
            console.error(
              "[AuthCallback] implicit _getSessionFromURL threw:",
              e
            );
            implicitErr = e;
          }

          if (implicitErr) {
            console.error(
              "[AuthCallback] implicit helper error:",
              implicitErr
            );
            setMsg(
              implicitErr.message ||
                "Could not finish sign-in. Please try again."
            );
            setTimeout(() => nav("/", { replace: true }), 2500);
            return;
          }

          const session = implicitData?.session;
          if (!session?.user) {
            console.error(
              "[AuthCallback] implicit helper returned no user",
              implicitData
            );
            setMsg("No session returned. Please try again.");
            setTimeout(() => nav("/", { replace: true }), 2500);
            return;
          }

          await privateSave(session);
          await privateNotify("SIGNED_IN", session);
          console.log(
            "[AuthCallback] implicit helper stored session for user:",
            session.user.id
          );

          window.history.replaceState({}, document.title, "/");
          setMsg("Signed in. Redirecting…");
          nav("/", { replace: true });
          return;
        }

        // ---- Nothing usable in URL ----------------------------------------
        console.error(
          "[AuthCallback] No code or tokens found in callback URL",
          url.toString()
        );
        setMsg("Missing auth code in callback. Please try again.");
        setTimeout(() => nav("/", { replace: true }), 2500);
      } catch (e) {
        console.error("[AuthCallback] Unexpected error:", e);
        setMsg(
          e?.message || "Unexpected error finishing sign-in. Please try again."
        );
        setTimeout(() => nav("/", { replace: true }), 2500);
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
