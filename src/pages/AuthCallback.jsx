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
    console.log("[AuthCallback] mounted", {
      path:
        typeof window !== "undefined"
          ? window.location.href
          : "(no-window href)",
    });

    (async () => {
      try {
        // Let Supabase finish exchanging tokens (implicit) then poll briefly
        let { data: s0 } = await supabase.auth.getSession();
        console.log("[AuthCallback] initial getSession", {
          hasSession: !!s0?.session,
          userId: s0?.session?.user?.id ?? null,
        });

        let session = s0?.session ?? null;
        for (let i = 0; !session && i < 6; i++) {
          await sleep(250);
          const { data: sn } = await supabase.auth.getSession();
          session = sn?.session ?? null;
          console.log("[AuthCallback] polling getSession", {
            attempt: i + 1,
            hasSession: !!session,
            userId: session?.user?.id ?? null,
          });
          if (session) break;
        }

        if (!session?.user?.id) {
          console.warn("[AuthCallback] no valid session after polling, aborting");
          return;
        }

        const newUserId = session.user.id;
        let guestId = null;
        try {
          guestId = localStorage.getItem(LS_GUEST_ID) || null;
        } catch (e) {
          console.warn("[AuthCallback] error reading LS_GUEST_ID", e);
        }

        console.log("[AuthCallback] session + guest info", {
          newUserId,
          guestId,
          LS_GUEST_ID,
        });

       // === RPC-only ADOPTION ===
if (guestId && guestId !== newUserId) {
  console.log("[AuthCallback] calling adopt_guest RPC", {
    p_old_user: guestId,
    newUserId,
  });

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
    console.log("[AuthCallback] adopt_guest RPC success", {
      guestId,
      newUserId,
      data,
    });
    // Expected shape from our updated function:
    // { ok: true, old_id, new_id, moved: { quizzes, groups, quiz_scores } }
  }
} else {
  console.log("[AuthCallback] no adoption needed", {
    guestId,
    newUserId,
  });
}


        // Clean up local flag regardless of outcome
        try {
          localStorage.removeItem(LS_GUEST_ID);
          console.log("[AuthCallback] removed LS_GUEST_ID from localStorage", {
            key: LS_GUEST_ID,
          });
        } catch (e) {
          console.warn("[AuthCallback] error removing LS_GUEST_ID", e);
        }

        // Optional: strip tokens from URL
        try {
          const clean = `${window.location.origin}/auth/callback`;
          window.history.replaceState({}, "", clean);
          console.log("[AuthCallback] cleaned URL to /auth/callback");
        } catch (e) {
          console.warn("[AuthCallback] error cleaning URL", e);
        }

        // Go home
        console.log("[AuthCallback] redirecting to /");
        window.location.replace("/");
      } catch (e) {
        console.error("[AuthCallback] outer error", e);
        // swallow errors, user will see fallback UI
      }
    })();
  }, []);

  return <SigningInOverlay />;
}
