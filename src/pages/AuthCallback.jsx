import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    (async () => {
      const url = new URL(window.location.href);
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");

      if (error) { setMsg(`Auth error: ${error}`); return; }
      if (!code) { setMsg("Missing auth code."); return; }

      // 1) Finish the Supabase auth exchange
      const { error: exchErr } = await supabase.auth.exchangeCodeForSession(code);
      if (exchErr) { setMsg(exchErr.message || "Could not finish sign-in."); return; }

      // 2) If we created a new email/password account as a fallback,
      //    adopt data from the previous anonymous user id.
      const oldId = localStorage.getItem("guest_to_adopt");
      if (oldId) {
        try {
          const { error: adoptErr } = await supabase.rpc("adopt_guest", { p_old_user: oldId });
          if (adoptErr) {
            // Don’t block the user—just show a note.
            console.error("adopt_guest failed:", adoptErr);
            setMsg("Signed in, but couldn't move guest data automatically. You can keep using the app.");
          } else {
            setMsg("Account upgraded. Your quizzes were moved to this account. Redirecting…");
          }
        } finally {
          localStorage.removeItem("guest_to_adopt");
        }
      } else {
        setMsg("Signed in. Redirecting…");
      }

      // 3) Go to the app
      nav("/", { replace: true });
    })();
  }, [nav]);

  return (
    <div className="min-h-screen grid place-items-center bg-gray-900 text-white">
      <div className="p-6 rounded-2xl bg-gray-800 border border-gray-700">{msg}</div>
    </div>
  );
}
