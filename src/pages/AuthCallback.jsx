import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    (async () => {
      try {
        const url = new URL(window.location.href);
        const error = url.searchParams.get("error");
        // Supabase v2 sends ?code=... (fallback keys included just in case)
        const code =
          url.searchParams.get("code") ||
          url.searchParams.get("token") ||
          url.searchParams.get("auth_code");

        if (error) {
          setMsg(`Auth error: ${error}`);
          return;
        }
        if (!code) {
          setMsg("Missing auth code.");
          return;
        }

        // 1) Finish the Supabase auth exchange (PKCE)
        const { error: exchErr } = await supabase.auth.exchangeCodeForSession(code);
        if (exchErr) {
          setMsg(exchErr.message || "Could not finish sign-in.");
          return;
        }

        // 2) Determine old guest id: prefer URL param, fallback to localStorage
        const guestFromUrl = url.searchParams.get("guest");
        const guestFromLS = localStorage.getItem("guest_to_adopt");
        const oldId = guestFromUrl || guestFromLS;

        if (oldId) {
          const { error: adoptErr } = await supabase.rpc("adopt_guest", {
            p_old_user: oldId,
          });

          if (adoptErr) {
            console.error("adopt_guest failed:", adoptErr);
            setMsg(
              "Signed in, but we couldn't automatically move your guest data. You can keep using the app."
            );
          } else {
            setMsg(
              "Account confirmed! Your guest quizzes were moved to this account. Redirecting…"
            );
          }
          // clean up local marker
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
    <div className="min-h-screen grid place-items-center bg-gray-900 text-white">
      <div className="p-6 rounded-2xl bg-gray-800 border border-gray-700">{msg}</div>
    </div>
  );
}
