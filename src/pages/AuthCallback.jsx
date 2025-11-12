// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

const LS_KEYS = ["guest_id_before_oauth", "guest_to_adopt"];

export default function AuthCallback() {
  const nav = useNavigate();
  const [status, setStatus] = useState("Finalizing sign-in…");

  useEffect(() => {
    (async () => {
      try {
        // Ensure OAuth session exists (Supabase sets it on return)
        const { data: sessData, error: sessErr } = await supabase.auth.getSession();
        if (sessErr) throw sessErr;
        const session = sessData?.session;
        const newUser = session?.user;
        if (!newUser?.id) throw new Error("No OAuth user session found.");

        // Read any stored guest id (support both old/new keys)
        let oldGuestId = null;
        try {
          for (const k of LS_KEYS) {
            const v = localStorage.getItem(k);
            if (v) {
              oldGuestId = v;
              break;
            }
          }
        } catch {}

        // If we have a prior guest different from current user, adopt its rows
        if (oldGuestId && oldGuestId !== newUser.id) {
          setStatus("Migrating your quizzes…");

          const { error: adoptErr } = await supabase.rpc("adopt_guest", {
            p_old_user: oldGuestId,
          });
          if (adoptErr) throw adoptErr;

          // Optional clean-up of old anon via Edge Function (if deployed)
          try {
            await supabase.functions.invoke("adopt-and-delete", {
              body: { old_user_id: oldGuestId },
            });
          } catch {
            // Non-fatal if function isn't deployed
          }

          try {
            for (const k of LS_KEYS) localStorage.removeItem(k);
          } catch {}
        }

        setStatus("All set. Redirecting…");
        nav("/", { replace: true });
      } catch (e) {
        console.error(e);
        setStatus("Sign-in completed, but adoption step failed. You can retry from the app.");
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
