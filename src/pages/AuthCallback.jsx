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
        const hashParams = new URLSearchParams(
          (window.location.hash || "").replace(/^#/, "")
        );

        const code = params.get("code");
        const error =
          params.get("error") || hashParams.get("error") || null;
        const errorDesc =
          params.get("error_description") ||
          hashParams.get("error_description") ||
          null;

        const hashSnapshot = Object.fromEntries(hashParams.entries());

        console.log("[AuthCallback] URL params:", Object.fromEntries(params.entries()));
        console.log("[AuthCallback] Hash params:", hashSnapshot);

        // Persist last callback for debugging
        try {
          localStorage.setItem(
            "last_auth_callback",
            JSON.stringify({
              ts: Date.now(),
              search: Object.fromEntries(params.entries()),
              hash: hashSnapshot,
            })
          );
        } catch {}

        // 1) Provider returned an error
        if (error) {
          const diagnostic = `Auth error: ${error}${
            errorDesc ? ` — ${errorDesc}` : ""
          }`;
          console.error("[AuthCallback]", diagnostic);
          setMsg(diagnostic);
          return;
        }

        // 2) PKCE code path (recommended / what we're using)
        if (code) {
          console.log("[AuthCallback] Exchanging PKCE code for session...");
          const { data, error: exchErr } =
            await supabase.auth.exchangeCodeForSession(code);

          if (exchErr) {
            console.error(
              "[AuthCallback] exchangeCodeForSession error:",
              exchErr
            );
            setMsg(
              exchErr.message ||
                "Could not finish sign-in (code exchange failed)."
            );
            return;
          }

          console.log(
            "[AuthCallback] exchangeCodeForSession success for user:",
            data?.session?.user?.id
          );
        }
        // 3) Legacy implicit fallback (just in case some flow still uses it)
        else if (hashParams.get("access_token")) {
          console.log("[AuthCallback] Using implicit tokens from hash to set session…");

          const internalGet =
            typeof supabase.auth._getSessionFromURL === "function"
              ? supabase.auth._getSessionFromURL.bind(supabase.auth)
              : null;
          const internalSave =
            typeof supabase.auth._saveSession === "function"
              ? supabase.auth._saveSession.bind(supabase.auth)
              : null;
          const internalNotify =
            typeof supabase.auth._notifyAllSubscribers === "function"
              ? supabase.auth._notifyAllSubscribers.bind(supabase.auth)
              : null;

          if (!internalGet || !internalSave || !internalNotify) {
            console.error(
              "[AuthCallback] Missing Supabase internal helpers for implicit flow"
            );
            setMsg(
              "Could not finish sign-in (client version mismatch for implicit flow)."
            );
            return;
          }

          const implicitParams = Object.fromEntries(hashParams.entries());
          const { data, error: impErr } = await internalGet(
            implicitParams,
            "implicit"
          );

          if (impErr) {
            console.error("[AuthCallback] implicit flow error:", impErr);
            setMsg(
              impErr.message || "Could not finish sign-in (implicit flow)."
            );
            return;
          }

          const session = data?.session;
          if (!session?.user) {
            console.error(
              "[AuthCallback] implicit flow returned no user",
              data
            );
            setMsg("No session returned from sign-in.");
            return;
          }

          await internalSave(session);
          await internalNotify("SIGNED_IN", session);
          console.log(
            "[AuthCallback] implicit flow stored session for:",
            session.user.id
          );
        }
        // 4) Nothing useful in the URL
        else {
          console.error("[AuthCallback] No code or tokens in callback URL");
          setMsg("Missing auth code in callback.");
          return;
        }

        // ---- Success: clean URL + go home ----
        window.history.replaceState({}, document.title, "/");
        setMsg("Signed in. Redirecting…");
        nav("/", { replace: true });
      } catch (e) {
        console.error("[AuthCallback] Unexpected error:", e);
        setMsg(e?.message || "Unexpected error while finishing sign-in.");
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
