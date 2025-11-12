// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { onAuthCallbackPath } from "../auth/AuthProvider";

const LS_GUEST_ID = "guest_id_before_oauth";

export default function AuthCallback() {
  const [msg, setMsg] = useState("Finishing sign-in…");
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const url = new URL(window.location.href);
        console.log("[AuthCallback] URL:", url.toString());

        const qp = Object.fromEntries(url.searchParams.entries());
        console.log("[AuthCallback] params:", qp);

        // If the provider sent back an error (like your screenshot)
        const rawError = qp.error || qp.error_code || null;
        const rawDesc = qp.error_description || qp.error_message || null;
        if (rawError) {
          console.error("[AuthCallback] OAuth error from provider:", rawError, rawDesc);
          setErr(`${rawDesc || rawError}`);
          setMsg("OAuth error. See console for details.");
          return;
        }

        // Get the current session (should now be Google/email user, not anon)
        const { data: sres } = await supabase.auth.getSession();
        const newUser = sres?.session?.user || null;
        console.log("[AuthCallback] session:", sres?.session);
        console.log("[AuthCallback] new user:", newUser);

        // Read stored guest id (if we started sign-in as a guest)
        const guestId = localStorage.getItem(LS_GUEST_ID) || null;
        console.log("[AuthCallback] stored guest id:", guestId);

        if (!newUser?.id) {
          console.warn("[AuthCallback] no authenticated user after redirect.");
          setMsg("No authenticated user. You can close this tab and try again.");
          return;
        }

        // If we have a guest id and it differs from new user, adopt it.
        if (guestId && guestId !== newUser.id) {
          console.log("[AuthCallback] adopting guest → new user", { guestId, newId: newUser.id });

          // OPTION A: Edge Function “adopt-and-delete” (recommended; you already have it)
          // Body includes access token for auth
          const { data: sess } = await supabase.auth.getSession();
          const accessToken = sess?.session?.access_token || null;

          if (!accessToken) {
            console.error("[AuthCallback] missing access token for adopt-and-delete");
          } else {
            try {
              const { error: fnError } = await supabase.functions.invoke("adopt-and-delete", {
                body: { old_user_id: guestId, new_user_id: newUser.id, accessToken },
              });
              if (fnError) {
                console.error("[AuthCallback] adopt-and-delete error:", fnError);
              } else {
                console.log("[AuthCallback] adopt completed via adopt-and-delete.");
              }
            } catch (e) {
              console.error("[AuthCallback] adopt-and-delete threw:", e);
            }
          }

          // OPTION B (fallback): direct RPC if you use it instead
          // await supabase.rpc("adopt_guest", { p_old_user: guestId });

          try {
            localStorage.removeItem(LS_GUEST_ID);
          } catch {}
        } else {
          console.log("[AuthCallback] no adoption needed (no guest id or same user).");
        }

        setMsg("Sign-in complete. You can close this tab.");
        // Small delay so the user sees success, then return home
        setTimeout(() => (window.location.href = "/"), 600);
      } catch (e) {
        console.error("[AuthCallback] unexpected error:", e);
        setErr(e?.message || "Unexpected error.");
        setMsg("Something went wrong. See console for details.");
      }
    })();
  }, []);

  return (
    <div className="min-h-screen grid place-items-center text-white">
      <div className="surface-card p-6 max-w-lg text-center">
        {err ? (
          <>
            <h1 className="text-2xl font-bold mb-2">OAuth error</h1>
            <p className="text-red-300">{err}</p>
            <p className="text-white/70 mt-3 text-sm">
              Open DevTools → Console to see detailed logs.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold mb-2">Please wait…</h1>
            <p className="text-white/80">{msg}</p>
          </>
        )}
      </div>
    </div>
  );
}
