// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { onAuthCallbackPath } from "../auth/AuthProvider";

const LS_GUEST_ID = "guest_id_before_oauth";

function parseHash(hash) {
  // "#access_token=...&refresh_token=..." → { access_token, refresh_token, ... }
  if (!hash) return {};
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

export default function AuthCallback() {
  const [msg, setMsg] = useState("Finishing sign-in…");
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const url = new URL(window.location.href);
        console.log("[AuthCallback] URL:", url.toString());
        console.log("[AuthCallback] location.search:", window.location.search);
        console.log("[AuthCallback] location.hash:", window.location.hash);

        const searchParams = Object.fromEntries(new URLSearchParams(url.search).entries());
        const hashParams = parseHash(window.location.hash);

        console.log("[AuthCallback] search params:", searchParams);
        console.log("[AuthCallback] hash params:", {
          keys: Object.keys(hashParams),
          has_access_token: Boolean(hashParams.access_token),
          has_refresh_token: Boolean(hashParams.refresh_token),
        });

        // If provider sent an error in query string
        const rawError = searchParams.error || searchParams.error_code || null;
        const rawDesc = searchParams.error_description || searchParams.error_message || null;
        if (rawError) {
          console.error("[AuthCallback] OAuth error from provider:", rawError, rawDesc);
          setErr(`${rawDesc || rawError}`);
          setMsg("OAuth error. See console for details.");
          return;
        }

        // Safety net: if implicit tokens are in hash, set session explicitly
        if (hashParams.access_token && hashParams.refresh_token) {
          console.log("[AuthCallback] setSession from hash tokens (implicit flow fallback)");
          const { data: setRes, error: setErrRes } = await supabase.auth.setSession({
            access_token: hashParams.access_token,
            refresh_token: hashParams.refresh_token,
          });
          console.log("[AuthCallback] setSession result:", { setRes, setErrRes });
          if (setErrRes) {
            console.error("[AuthCallback] setSession error:", setErrRes);
          }
        }

        // Poll briefly until we have a session/user (covers PKCE auto-exchange)
        let tries = 0;
        let got = null;
        while (tries < 20) {
          const { data: sres } = await supabase.auth.getSession();
          if (sres?.session?.user) {
            got = sres.session;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
          tries++;
        }

        console.log("[AuthCallback] final session:", got);
        const newUser = got?.user || null;
        console.log("[AuthCallback] final user:", newUser);

        if (!newUser?.id) {
          console.warn("[AuthCallback] no authenticated user after redirect.");
          setMsg("No authenticated user. You can close this tab and try again.");
          return;
        }

        // Adoption: move guest data → new user if needed
        const guestId = localStorage.getItem(LS_GUEST_ID) || null;
        console.log("[AuthCallback] stored guest id:", guestId);

        if (guestId && guestId !== newUser.id) {
          console.log("[AuthCallback] adopting guest → new user", { guestId, newId: newUser.id });

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

          try { localStorage.removeItem(LS_GUEST_ID); } catch {}
        } else {
          console.log("[AuthCallback] no adoption needed (no guest id or same user).");
        }

        setMsg("Sign-in complete. You can close this tab.");
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
            <p className="text-white/70 mt-3 text-sm">Open DevTools → Console to see detailed logs.</p>
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
