import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

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
        const params = Object.fromEntries(url.searchParams.entries());
        const hash = (window.location.hash || "").replace(/^#/, "");
        const hashParams = new URLSearchParams(hash);
        const hashObj = Object.fromEntries(hashParams.entries());

        console.log("[AuthCallback] URL params:", params);
        console.log("[AuthCallback] Hash params:", hashObj);

        const error = params.error || hashParams.get("error");
        const errorDesc =
          params.error_description || hashParams.get("error_description");

        if (error) {
          const diagnostic = `Auth error: ${error}${
            errorDesc ? ` — ${errorDesc}` : ""
          }`;
          console.error("[AuthCallback]", diagnostic);
          setMsg(diagnostic);
          return;
        }

        const code = params.code || null;
        const hasImplicitTokens =
          hashParams.get("access_token") || hashParams.get("refresh_token");

        // ---- PKCE code flow -------------------------------------------------
        if (code) {
          console.log(
            "[AuthCallback] Exchanging PKCE code for session…",
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
            return;
          }

          console.log(
            "[AuthCallback] PKCE exchange success, user:",
            data?.session?.user?.id || null
          );
        }
        // ---- Implicit (hash) fallback (older clients / providers) ----------
        else if (hasImplicitTokens) {
          console.log(
            "[AuthCallback] Using implicit tokens from hash to set session"
          );

          const privGet =
            typeof supabase.auth._getSessionFromURL === "function"
              ? supabase.auth._getSessionFromURL.bind(supabase.auth)
              : null;
          const privSave =
            typeof supabase.auth._saveSession === "function"
              ? supabase.auth._saveSession.bind(supabase.auth)
              : null;
          const privNotify =
            typeof supabase.auth._notifyAllSubscribers === "function"
              ? supabase.auth._notifyAllSubscribers.bind(supabase.auth)
              : null;

          if (!privGet || !privSave || !privNotify) {
            console.error(
              "[AuthCallback] implicit flow helpers missing on client"
            );
            setMsg("Could not finish sign-in (client mismatch).");
            return;
          }

          const { data, error: implErr } = await privGet(
            Object.fromEntries(hashParams.entries()),
            "implicit"
          );
          if (implErr) {
            console.error("[AuthCallback] implicit error:", implErr);
            setMsg(implErr.message || "Could not finish sign-in.");
            return;
          }

          const session = data?.session;
          if (!session?.user) {
            console.error(
              "[AuthCallback] implicit returned no user",
              data || null
            );
            setMsg("No session returned. Please try again.");
            return;
          }

          await privSave(session);
          await privNotify("SIGNED_IN", session);
          console.log(
            "[AuthCallback] implicit session stored for user:",
            session.user.id
          );
        } else {
          console.error(
            "[AuthCallback] No code or tokens found in callback URL."
          );
          setMsg("Missing auth code in callback. Please try again.");
          return;
        }

        // Clean URL and send home
        window.history.replaceState({}, document.title, "/");
        setMsg("Signed in. Redirecting…");
        nav("/", { replace: true });
      } catch (e) {
        console.error("[AuthCallback] Unexpected error:", e);
        setMsg(e?.message || "Unexpected error finishing sign-in.");
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
