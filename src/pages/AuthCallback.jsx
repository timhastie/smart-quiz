// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const LS_GUEST_ID = "guest_id_before_oauth";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default function AuthCallback() {
  const [msg, setMsg] = useState("Finishing sign-in...");

  useEffect(() => {
    (async () => {
      try {
        console.log("[AuthCallback] start");
        console.log("[AuthCallback] URL:", window.location.href);

        // Let Supabase finish exchanging tokens (implicit) then poll briefly
        let { data: s0 } = await supabase.auth.getSession();
        console.log("[AuthCallback] initial getSession:", s0?.session);

        let session = s0?.session ?? null;
        for (let i = 0; !session && i < 6; i++) {
          await sleep(250);
          const { data: sn } = await supabase.auth.getSession();
          session = sn?.session ?? null;
          console.log(`[AuthCallback] getSession poll ${i + 1}:`, session);
        }

        if (!session?.user?.id) {
          console.error("[AuthCallback] no session after OAuth — abort");
          setMsg("OAuth error: no session");
          return;
        }

        const newUserId = session.user.id;
        const guestId = localStorage.getItem(LS_GUEST_ID) || null;

        console.log("[AuthCallback] new user id:", newUserId);
        console.log("[AuthCallback] stored guest id:", guestId);

        // === RPC-only ADOPTION ===
        if (guestId && guestId !== newUserId) {
          setMsg("Linking your guest data...");
          console.log("[AuthCallback] calling RPC adopt_guest with", {
            p_old_user: guestId,
          });

          const { data, error } = await supabase.rpc("adopt_guest", {
            p_old_user: guestId,
          });

          console.log("[AuthCallback] adopt_guest result:", { data, error });

          if (error) {
            console.error("[AuthCallback] adopt_guest error:", error);
            setMsg(`Adopt error: ${error.message ?? String(error)}`);
          } else {
            // Expected shape from our updated function:
            // { ok: true, old_id, new_id, moved: { quizzes, groups, quiz_scores } }
            const moved = data?.moved ?? {};
            console.log(
              "[AuthCallback] moved counts:",
              moved.quizzes,
              moved.groups,
              moved.quiz_scores
            );
            setMsg("Success! Bringing your quizzes over…");
          }
        } else {
          console.log("[AuthCallback] no adoption needed (no guestId or same user)");
        }

        // Clean up local flag regardless of outcome
        try {
          localStorage.removeItem(LS_GUEST_ID);
          console.log("[AuthCallback] cleared LS guest id");
        } catch {}

        // Optional: strip tokens from URL
        try {
          const clean = `${window.location.origin}/auth/callback`;
          window.history.replaceState({}, "", clean);
          console.log("[AuthCallback] cleaned URL");
        } catch {}

        // Go home
        window.location.replace("/");
      } catch (e) {
        console.error("[AuthCallback] fatal:", e);
        setMsg(`OAuth error: ${e?.message ?? String(e)}`);
      }
    })();
  }, []);

  return (
    <div className="min-h-screen grid place-items-center text-slate-100">
      <div className="bg-black/40 rounded-xl px-6 py-4">
        <div className="text-xl font-semibold">Please wait...</div>
        <div className="opacity-80">{msg}</div>
      </div>
    </div>
  );
}
