// src/pages/AuthCallback.jsx
import { useEffect } from "react";
import { supabase } from "../lib/supabase";
import SigningInOverlay from "../components/SigningInOverlay";

const LS_GUEST_ID = "guest_id_before_oauth";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default function AuthCallback() {
  useEffect(() => {
    (async () => {
      try {
        // Let Supabase finish exchanging tokens (implicit) then poll briefly
        let { data: s0 } = await supabase.auth.getSession();

        let session = s0?.session ?? null;
        for (let i = 0; !session && i < 6; i++) {
          await sleep(250);
          const { data: sn } = await supabase.auth.getSession();
          session = sn?.session ?? null;
        }

        if (!session?.user?.id) {
          return;
        }

        const newUserId = session.user.id;
        const guestId = localStorage.getItem(LS_GUEST_ID) || null;

        // === RPC-only ADOPTION ===
        if (guestId && guestId !== newUserId) {
          const { data, error } = await supabase.rpc("adopt_guest", {
            p_old_user: guestId,
          });

          if (error) {
          } else {
            // Expected shape from our updated function:
            // { ok: true, old_id, new_id, moved: { quizzes, groups, quiz_scores } }
          }
        }

        // Clean up local flag regardless of outcome
        try {
          localStorage.removeItem(LS_GUEST_ID);
        } catch {}

        // Optional: strip tokens from URL
        try {
          const clean = `${window.location.origin}/auth/callback`;
          window.history.replaceState({}, "", clean);
        } catch {}

        // Go home
        window.location.replace("/");
      } catch (e) {
        // swallow errors, user will see fallback UI
      }
    })();
  }, []);

  return <SigningInOverlay />;
}
