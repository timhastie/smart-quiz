import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

// DEBUG: expose client for console tests (safe in dev)
if (typeof window !== "undefined") window.__sb = supabase;

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    (async () => {
      try {
        const url = new URL(window.location.href);
        const error = url.searchParams.get("error");
        const errorDesc = url.searchParams.get("error_description");
        // Supabase v2 sends ?code=... (fallback keys just in case)
        const code =
          url.searchParams.get("code") ||
          url.searchParams.get("token") ||
          url.searchParams.get("auth_code");

        console.log("[AuthCallback] URL params:", Object.fromEntries(url.searchParams.entries()));

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
        if (!code) {
          const dbg = `[AuthCallback] Missing auth code in ${url.toString()}`;
          console.error(dbg);
          setMsg("Missing auth code.");
          alert("Missing auth code — see console for details.");
          return;
        }

        // 1) Finish the Supabase auth exchange (PKCE)
        const { error: exchErr } = await supabase.auth.exchangeCodeForSession(code);
        if (exchErr) {
          console.error("[AuthCallback] exchangeCodeForSession error:", exchErr);
          setMsg(exchErr.message || "Could not finish sign-in.");
          return;
        }

        // 2) Determine old guest id: prefer URL param, fallback to localStorage
        const guestFromUrl = url.searchParams.get("guest");
        const guestFromLS = localStorage.getItem("guest_to_adopt");
        const oldId = guestFromUrl || guestFromLS;
        console.log("[callback] guestFromUrl:", guestFromUrl, "guestFromLS:", guestFromLS);

        // 2a) Guard: if the id is stale (no quizzes), skip adopting
        let shouldAdopt = !!oldId;
        if (oldId) {
          const { count: oldQuizCount, error: cntErr } = await supabase
            .from("quizzes")
            .select("id", { count: "exact", head: true })
            .eq("user_id", oldId);

          if (cntErr) {
          console.warn("Could not check old guest quizzes:", cntErr);
        } else if ((oldQuizCount ?? 0) === 0) {
            console.log("No quizzes found for old guest id -> skipping adopt");
            shouldAdopt = false;
          }
        }

        if (shouldAdopt) {
          const { error: adoptErr } = await supabase.rpc("adopt_guest", { p_old_user: oldId });
          if (adoptErr) {
            console.error("adopt_guest failed:", adoptErr);
            setMsg(
              "Signed in, but we couldn't automatically move your guest data. You can keep using the app."
            );
          } else {
            setMsg("Account confirmed! Your guest quizzes were moved to this account. Redirecting…");
          }
          // clean up local marker either way
          localStorage.removeItem("guest_to_adopt");
        } else {
          setMsg("Signed in. Redirecting…");
        }

        // 3) Redirect home (or change to your preferred landing page)
        nav("/", { replace: true });
      } catch (e) {
        console.error(e);
        setMsg("Unexpected error finishing sign-in.");
      }
    })();
  }, [nav]);

  return (
    <div className="min-h-screen grid place-items-center px-4 py-10 text-slate-100">
      <div className="surface-card p-6 sm:p-7 text-center text-white/80 max-w-md">{msg}</div>
    </div>
  );
}
