// src/pages/AuthCallback.jsx
import { useEffect } from "react";
import { supabase } from "../lib/supabase";
import SigningInOverlay from "../components/SigningInOverlay";

const LS_GUEST_ID = "guest_id_before_oauth";
const LS_OAUTH_RETURN_PATH = "oauth_return_path";

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

          if (session) break;
        }

        if (!session?.user?.id) {
          console.warn("[AuthCallback] no valid session after polling, aborting");
          return;
        }

        const newUserId = session.user.id;
        let guestId = null;
        let returnPath = null;

        try {
          guestId = localStorage.getItem(LS_GUEST_ID) || null;
        } catch (e) {
          console.warn("[AuthCallback] error reading LS_GUEST_ID", e);
        }

        try {
          returnPath = localStorage.getItem(LS_OAUTH_RETURN_PATH) || null;
        } catch (e) {
          console.warn("[AuthCallback] error reading LS_OAUTH_RETURN_PATH", e);
        }



        // === RPC-only ADOPTION ===
        if (guestId && guestId !== newUserId) {


          const { data, error } = await supabase.rpc("adopt_guest", {
            p_old_user: guestId,
          });

          if (error) {
            console.error("[AuthCallback] adopt_guest RPC error", {
              guestId,
              newUserId,
              message: error.message,
              details: error.details,
              hint: error.hint,
              code: error.code,
              raw: error,
            });
          } else {

            // Expected shape from our updated function:
            // { ok: true, old_id, new_id, moved: { quizzes, groups, quiz_scores } }
          }
        } else {

        }

        // Clean up local flags regardless of outcome
        try {
          localStorage.removeItem(LS_GUEST_ID);

        } catch (e) {
          console.warn("[AuthCallback] error removing LS_GUEST_ID", e);
        }

        try {
          if (returnPath) {
            localStorage.removeItem(LS_OAUTH_RETURN_PATH);

          }
        } catch (e) {
          console.warn("[AuthCallback] error removing LS_OAUTH_RETURN_PATH", e);
        }

        // Optional: strip tokens from URL
        try {
          const clean = `${window.location.origin}/auth/callback`;
          window.history.replaceState({}, "", clean);

        } catch (e) {
          console.warn("[AuthCallback] error cleaning URL", e);
        }

        // Go back to where the user started OAuth (fallback to /)
        const target =
          returnPath && typeof returnPath === "string" ? returnPath : "/";

        window.location.replace(target);
      } catch (e) {
        console.error("[AuthCallback] outer error", e);
        // swallow errors, user will see fallback UI
      }
    })();
  }, []);

  return <SigningInOverlay />;
}
