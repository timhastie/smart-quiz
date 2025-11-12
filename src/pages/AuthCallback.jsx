// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

const LS_GUEST_ID = "guest_id_before_oauth";

// Small helper to print clearly
function log(label, data) {
  // eslint-disable-next-line no-console
  console.log(`[AuthCallback] ${label}:`, data);
}

export default function AuthCallback() {
  const nav = useNavigate();
  const [status, setStatus] = useState("Finalizing sign-in…");

  useEffect(() => {
    (async () => {
      try {
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const error_description = url.searchParams.get("error_description");

        log("URL", window.location.href);
        log("params", { code, state, error, error_description });

        if (error) {
          setStatus(`OAuth error: ${error_description || error}`);
          log("STOP (OAuth error)", { error, error_description });
          return;
        }

        // Supabase PKCE needs this localStorage key to exist (set during signInWithOAuth redirect)
        const PKCE_KEY = "sb-pkce-code-verifier";
        const hasPkce = !!localStorage.getItem(PKCE_KEY);
        log("PKCE verifier present?", hasPkce);

        if (!code) {
          setStatus("No OAuth code in URL. Did the provider redirect here?");
          log("STOP (no code)", null);
          return;
        }

        // ---- 1) Exchange the code for a session (try both call signatures, log results) ----
        setStatus("Exchanging code for session…");
        let try1Err = null;
        let try2Err = null;

        // Preferred signature (supabase-js v2): pass full URL
        // Some builds require object signature; we’ll try both to be safe and log either failure.
        const t1 = performance.now();
        const r1 = await supabase.auth.exchangeCodeForSession(window.location.href);
        const t1ms = Math.round(performance.now() - t1);
        try1Err = r1?.error || null;
        log("exchangeCodeForSession(url)", { took_ms: t1ms, error: try1Err?.message || null });

        if (try1Err) {
          const t2 = performance.now();
          const r2 = await supabase.auth.exchangeCodeForSession({ code });
          const t2ms = Math.round(performance.now() - t2);
          try2Err = r2?.error || null;
          log("exchangeCodeForSession({code})", { took_ms: t2ms, error: try2Err?.message || null });

          if (try2Err) {
            setStatus("Code exchange failed.");
            throw try2Err;
          }
        }

        // ---- 2) Confirm session & user ----
        setStatus("Fetching session…");
        const { data: sessData, error: sessErr } = await supabase.auth.getSession();
        log("getSession", { error: sessErr?.message || null, user: sessData?.session?.user || null });

        if (sessErr || !sessData?.session?.user?.id) {
          setStatus("Session missing after exchange.");
          throw sessErr || new Error("No user after exchange.");
        }

        const newUser = sessData.session.user;

        // ---- 3) Adoption (guest → user), with detailed logging ----
        let oldGuestId = null;
        try {
          oldGuestId = localStorage.getItem(LS_GUEST_ID);
        } catch {}
        log("adoption - oldGuestId", oldGuestId);

        if (oldGuestId && oldGuestId !== newUser.id) {
          setStatus("Migrating your quizzes…");
          const { error: adoptErr } = await supabase.rpc("adopt_guest", { p_old_user: oldGuestId });
          log("adopt_guest RPC", { error: adoptErr?.message || null });

          if (adoptErr) {
            // Not fatal for login—surface clearly then continue
            setStatus("Signed in, but quiz migration failed.");
            // eslint-disable-next-line no-console
            console.error("[AuthCallback] adopt_guest failed:", adoptErr);
          } else {
            try {
              localStorage.removeItem(LS_GUEST_ID);
            } catch {}
          }
        }

        // ---- 4) Cleanup URL (remove ?code, etc.) and go home ----
        setStatus("All set. Redirecting…");
        // Remove querystring noise without an extra render
        window.history.replaceState({}, "", `${window.location.origin}/auth/callback`);
        nav("/", { replace: true });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[AuthCallback] FATAL", e);
        setStatus(`Sign-in failed: ${e?.message || e}`);
      }
    })();
  }, [nav]);

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="text-center text-slate-200 space-y-2">
        <p className="text-lg font-medium">{status}</p>
        <p className="text-sm opacity-70">Open DevTools → Console for detailed logs.</p>
      </div>
    </div>
  );
}
