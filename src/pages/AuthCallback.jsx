// src/pages/AuthCallback.jsx
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

// DEBUG: expose client for console tests
if (typeof window !== "undefined") window.__sb = supabase;

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
        const searchParams = Object.fromEntries(url.searchParams.entries());
        const hashParams = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
        const hashObj = Object.fromEntries(hashParams.entries());

        console.log("[AuthCallback] URL params:", searchParams);
        console.log("[AuthCallback] Hash params:", hashObj);

        const err =
          searchParams.error || hashParams.get("error") || null;
        const errDesc =
          searchParams.error_description ||
          hashParams.get("error_description") ||
          null;

        if (err) {
          const diagnostic = `Auth error: ${err}${errDesc ? ` — ${errDesc}` : ""}`;
          console.error("[AuthCallback]", diagnostic);
          setMsg(diagnostic);
          alert(diagnostic);
          return;
        }

        const code = searchParams.code;
        const hasImplicitTokens =
          hashParams.get("access_token") || hashParams.get("refresh_token");

        if (code) {
          // ---- PKCE / code flow ----
          console.log("[AuthCallback] Exchanging PKCE code for session...", code);

          const { data, error: exchErr } =
            await supabase.auth.exchangeCodeForSession(code);

          console.log("[AuthCallback] PKCE exchange result:", { data, exchErr });

          if (exchErr) {
            console.error("[AuthCallback] PKCE exchange error:", exchErr);
            setMsg(exchErr.message || "Could not finish sign-in.");
            alert(exchErr.message || "Could not finish sign-in.");
            return;
          }
        } else if (hasImplicitTokens) {
          // ---- Fallback: implicit (hash tokens) ----
          console.log("[AuthCallback] Using implicit tokens from hash to set session…");

          const authAny = supabase.auth;
          const get =
            authAny._getSessionFromURL?.bind(authAny) || null;
          const save =
            authAny._saveSession?.bind(authAny) || null;
          const notify =
            authAny._notifyAllSubscribers?.bind(authAny) || null;

          if (!get || !save || !notify) {
            const m = "Supabase client missing helpers for implicit flow.";
            console.error("[AuthCallback]", m);
            setMsg(m);
            alert(m);
            return;
          }

          const { data, error: implicitErr } = await get(hashObj, "implicit");
          console.log("[AuthCallback] implicit result:", { data, implicitErr });

          if (implicitErr) {
            console.error("[AuthCallback] implicit error:", implicitErr);
            setMsg(implicitErr.message || "Could not finish sign-in.");
            alert(implicitErr.message || "Could not finish sign-in.");
            return;
          }

          const session = data?.session;
          if (!session?.user) {
            const m = "No session returned from implicit flow.";
            console.error("[AuthCallback]", m, data);
            setMsg(m);
            alert(m);
            return;
          }

          await save(session);
          await notify("SIGNED_IN", session);
          console.log("[AuthCallback] implicit flow stored session for user:", session.user.id);
        } else {
          // ---- Nothing to work with ----
          const m = "Missing auth code in callback URL.";
          console.error("[AuthCallback]", m, { fullUrl: url.toString() });
          setMsg("Missing auth code in callback. Please try again.");
          alert("Missing auth code in callback. See console for details.");
          return;
        }

        // Success: clean URL and go home
        window.history.replaceState({}, document.title, "/");
        setMsg("Signed in. Redirecting…");
        console.log("[AuthCallback] Success → navigating to /");
        nav("/", { replace: true });
      } catch (e) {
        console.error("[AuthCallback] Unexpected error:", e);
        setMsg(e?.message || "Unexpected error finishing sign-in.");
        alert(e?.message || "Unexpected error finishing sign-in.");
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
