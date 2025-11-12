// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

// (Optional) expose for console debugging
if (typeof window !== "undefined") window.__sb = supabase;

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    (async () => {
      try {
        const href = window.location.href;
        const url = new URL(href);
        const err = url.searchParams.get("error");
        if (err) {
          setMsg(`Auth error: ${err}`);
          return;
        }

        // Finish PKCE auth using the full URL (recommended API)
        const { error: exchErr } = await supabase.auth.exchangeCodeForSession(href);
        if (exchErr) {
          setMsg(exchErr.message || "Could not finish sign-in.");
          return;
        }

        // If we previously had a guest, adopt its data now
        const pendingGuestId = localStorage.getItem("pending_guest_id");
        if (pendingGuestId) {
          const { error: adoptErr } = await supabase.rpc("adopt_guest", {
            p_old_user: pendingGuestId,
          });
          if (adoptErr) {
            console.error("adopt_guest failed:", adoptErr);
            setMsg(
              "Signed in, but we couldn't automatically move your guest data. You can keep using the app."
            );
          } else {
            setMsg("Account confirmed! Your guest quizzes were moved to this account. Redirecting…");
          }
          localStorage.removeItem("pending_guest_id");
        } else {
          setMsg("Signed in. Redirecting…");
        }

        // Go home
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
