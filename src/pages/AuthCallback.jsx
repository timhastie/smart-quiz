// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

const LS_GUEST_ID = "guest_id_before_oauth";

export default function AuthCallback() {
  const nav = useNavigate();
  const [status, setStatus] = useState("Finalizing sign-in…");

  useEffect(() => {
    (async () => {
      try {
        // 1) Exchange the OAuth "code" in the URL for a session (PKCE flow)
        //    Different supabase-js versions accept either no arg or the full URL.
        //    Try the recommended call; fall back to URL variant if needed.
        let exchErr = null;
        try {
          const { error } = await supabase.auth.exchangeCodeForSession();
          exchErr = error || null;
        } catch (e) {
          // Older builds sometimes expect the URL passed explicitly:
          const { error } = await supabase.auth.exchangeCodeForSession(window.location.href);
          exchErr = error || null;
        }
        if (exchErr) throw exchErr;

        // 2) Confirm session exists
        const { data: sessData, error: sessErr } = await supabase.auth.getSession();
        if (sessErr) throw sessErr;
        const newUser = sessData.session?.user;
        if (!newUser?.id) throw new Error("No OAuth user session found after exchange.");

        // 3) Optional guest → member adoption
        let oldGuestId = null;
        try { oldGuestId = localStorage.getItem(LS_GUEST_ID) || null; } catch {}
        if (oldGuestId && oldGuestId !== newUser.id) {
          setStatus("Migrating your quizzes…");
          const { error: adoptErr } = await supabase.rpc("adopt_guest", { p_old_user: oldGuestId });
          if (adoptErr) throw adoptErr;
          try { localStorage.removeItem(LS_GUEST_ID); } catch {}
        }

        setStatus("All set. Redirecting…");
        nav("/", { replace: true });
      } catch (e) {
        console.error(e);
        setStatus("Sign-in finished, but adoption/finalize failed. You'll be redirected…");
        setTimeout(() => nav("/", { replace: true }), 900);
      }
    })();
  }, [nav]);

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="text-center text-slate-200">
        <p className="text-lg">{status}</p>
      </div>
    </div>
  );
}
