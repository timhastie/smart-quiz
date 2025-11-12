// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const LS_GUEST_ID = "guest_id_before_oauth";

export default function AuthCallback() {
  const [msg, setMsg] = useState("Finishing sign-in...");

  useEffect(() => {
    (async () => {
      try {
        console.log("[AuthCallback] URL:", window.location.href);

        // Show what came back in the URL (useful when implicit flow is used)
        const hash = window.location.hash ?? "";
        const qp = window.location.search ?? "";
        console.log("[AuthCallback] location.hash:", hash);
        console.log("[AuthCallback] location.search:", qp);

        // Get the (possibly newly-established) session
        const { data: s1 } = await supabase.auth.getSession();
        console.log("[AuthCallback] initial getSession:", s1?.session);

        // If not populated yet, wait briefly and retry once
        let session = s1.session;
        if (!session) {
          console.log("[AuthCallback] no session yet -> small wait");
          await new Promise((r) => setTimeout(r, 400));
          const { data: s2 } = await supabase.auth.getSession();
          session = s2.session;
          console.log("[AuthCallback] getSession after wait:", session);
        }

        if (!session?.user?.id) {
          console.error("[AuthCallback] no session after OAuth. Aborting.");
          setMsg("OAuth error: no session");
          return;
        }

        const newUserId = session.user.id;
        const guestId = localStorage.getItem(LS_GUEST_ID);
        console.log("[AuthCallback] new signed-in user:", newUserId);
        console.log("[AuthCallback] stored guest id:", guestId);

        // --- ADOPT GUEST DATA (Edge Function) ---
        if (guestId && guestId !== newUserId) {
          setMsg("Adopting your previous guest data...");
          console.log("[AuthCallback] invoking adopt-and-delete for", { old_id: guestId });

          const { data, error } = await supabase.functions.invoke("adopt-and-delete", {
            body: { old_id: guestId },
            headers: { "x-client": "web" }, // shows in function logs if you print it
          });

          console.log("[AuthCallback] adopt response:", { data, error });

          if (error) {
            console.warn("[AuthCallback] adopt error:", error);
            setMsg(`Adopt error: ${error.message ?? String(error)}`);
          } else {
            setMsg("Success! Finishing up...");
          }
        } else {
          console.log("[AuthCallback] no adopt needed (no guest id or same user)");
        }
        // --- END ADOPT ---

        // Clean up the localStorage flag either way
        try {
          localStorage.removeItem(LS_GUEST_ID);
          console.log("[AuthCallback] cleared LS guest id");
        } catch (e) {
          console.warn("[AuthCallback] LS cleanup warn:", e);
        }

        // Optional: strip tokens from URL for a clean history entry
        try {
          const clean = window.location.origin + "/auth/callback";
          window.history.replaceState({}, "", clean);
          console.log("[AuthCallback] cleaned URL");
        } catch (e) {
          console.warn("[AuthCallback] URL clean warn:", e);
        }

        // Go to dashboard; if adopt worked, your quizzes should be attached now
        window.location.replace("/");
      } catch (e) {
        console.error("[AuthCallback] fatal error:", e);
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
