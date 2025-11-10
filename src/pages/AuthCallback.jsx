// src/auth/AuthCallback.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

if (typeof window !== "undefined") window.__sb = supabase;

function buildRedirectURL(guestId) {
  const url = new URL(`${window.location.origin}/auth/callback`);
  if (guestId) url.searchParams.set("guest", guestId);
  return url.toString();
}

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    (async () => {
      try {
        const url = new URL(window.location.href);

        const error = url.searchParams.get("error");
        const errorDesc =
          url.searchParams.get("error_description") ||
          url.searchParams.get("error_description_message") ||
          "";

        const rawCode =
          url.searchParams.get("code") ||
          url.searchParams.get("token") ||
          url.searchParams.get("auth_code") ||
          "";

        const guestFromUrl = url.searchParams.get("guest");
        let guestFromLS = null;
        try {
          guestFromLS = localStorage.getItem("guest_to_adopt");
        } catch {
          guestFromLS = null;
        }
        const oldGuestId = guestFromUrl || guestFromLS || null;

        console.log("[AuthCallback] URL params:", {
          search: url.search,
          hash: url.hash,
          error,
          errorDesc,
          rawCode,
          guestFromUrl,
          guestFromLS,
        });

        /* ---------------------------------------------------------- *
         * 1. Special-case: "Identity is already linked to another user"
         * ---------------------------------------------------------- */
        if (
          error &&
          /identity is already linked to another user/i.test(
            errorDesc || error
          )
        ) {
          console.log(
            "[AuthCallback] 'identity already linked' error detected."
          );

          if (!oldGuestId) {
            console.warn(
              "[AuthCallback] No guest id available; cannot adopt."
            );
            setMsg(
              "Auth error: that Google account is already linked to another user."
            );
            return;
          }

          // Persist marker for the *next* callback
          try {
            localStorage.setItem("guest_to_adopt", oldGuestId);
          } catch {}

          setMsg(
            "That Google account is already linked. Signing you into it and moving your quizzes…"
          );

          const redirectTo = buildRedirectURL(oldGuestId);

          // This triggers a new full OAuth sign-in to the existing account.
          const { error: retryErr } = await supabase.auth.signInWithOAuth({
            provider: "google",
            options: { redirectTo },
          });

          if (retryErr) {
            console.error(
              "[AuthCallback] Retry signInWithOAuth failed:",
              retryErr
            );
            setMsg(
              "Could not complete sign-in after link conflict. Please try again."
            );
          } else {
            console.log(
              "[AuthCallback] Launched second OAuth flow to existing Google user."
            );
          }
          return; // browser is navigating away
        }

        /* ----------------------------- *
         * 2. Any other explicit error
         * ----------------------------- */
        if (error) {
          console.error("[AuthCallback] Auth error:", { error, errorDesc });
          setMsg(
            `Auth error: ${error}${
              errorDesc ? ` — ${errorDesc}` : ""
            }`
          );
          return;
        }

        /* ------------------------------------------------
         * 3. Finish login: either via code OR existing
         *    session (Safari implicit/hash flow case)
         * ------------------------------------------------ */

        let authedUser = null;

        if (rawCode) {
          console.log(
            "[AuthCallback] Found auth code; exchanging for session…"
          );
          const { data: exchData, error: exchErr } =
            await supabase.auth.exchangeCodeForSession(rawCode);

          if (exchErr) {
            console.error(
              "[AuthCallback] exchangeCodeForSession error:",
              exchErr
            );
            setMsg(
              exchErr.message ||
                "Could not finish sign-in. Please try again."
            );
            return;
          }

          authedUser = exchData?.session?.user || exchData?.user || null;
          console.log("[AuthCallback] Session via code:", {
            id: authedUser?.id,
            email: authedUser?.email,
            providers: authedUser?.app_metadata?.providers,
          });
        } else {
          // No code in URL. This is where Safari / implicit flow lands.
          console.log(
            "[AuthCallback] No auth code in URL; checking existing session…"
          );
          const { data: sessData, error: sessErr } =
            await supabase.auth.getSession();

          if (sessErr) {
            console.error(
              "[AuthCallback] getSession error (no code path):",
              sessErr
            );
          }

          const sessUser = sessData?.session?.user || null;
          if (sessUser) {
            authedUser = sessUser;
            console.log(
              "[AuthCallback] Using existing session from hash/implicit:",
              {
                id: authedUser.id,
                email: authedUser.email,
                providers: authedUser?.app_metadata?.providers,
              }
            );
          } else {
            console.error(
              "[AuthCallback] No code and no active session -> real failure."
            );
            setMsg("Missing auth code.");
            return;
          }
        }

        /* ----------------------------------------- *
         * 4. Guest adoption (move quizzes)
         * ----------------------------------------- */
        if (oldGuestId && authedUser?.id && oldGuestId !== authedUser.id) {
          console.log(
            "[AuthCallback] Considering adopt_guest from",
            oldGuestId,
            "to",
            authedUser.id
          );

          // Optional: only run if guest actually has quizzes
          const { count: oldQuizCount, error: cntErr } = await supabase
            .from("quizzes")
            .select("id", { count: "exact", head: true })
            .eq("user_id", oldGuestId);

          if (cntErr) {
            console.warn(
              "[AuthCallback] Could not count guest quizzes:",
              cntErr
            );
          } else {
            console.log(
              "[AuthCallback] Guest quiz count:",
              oldQuizCount ?? 0
            );
          }

          if (!cntErr && (oldQuizCount ?? 0) > 0) {
            console.log("[AuthCallback] Running adopt_guest…");
            const { error: adoptErr } = await supabase.rpc("adopt_guest", {
              p_old_user: oldGuestId,
            });
            if (adoptErr) {
              console.error(
                "[AuthCallback] adopt_guest failed:",
                adoptErr
              );
              setMsg(
                "Signed in, but we couldn't automatically move your guest data. You can keep using the app."
              );
            } else {
              console.log(
                "[AuthCallback] adopt_guest succeeded; clearing marker."
              );
              setMsg(
                "Account ready! Your guest quizzes were moved to this account. Redirecting…"
              );
            }
          } else {
            console.log(
              "[AuthCallback] No guest quizzes found; skipping adopt_guest."
            );
            setMsg("Signed in. Redirecting…");
          }

          try {
            localStorage.removeItem("guest_to_adopt");
          } catch {}
        } else {
          setMsg("Signed in. Redirecting…");
        }

        /* ----------------------------------------- *
         * 5. Redirect home
         * ----------------------------------------- */
        console.log("[AuthCallback] Navigation -> /");
        nav("/", { replace: true });
      } catch (e) {
        console.error("[AuthCallback] Unexpected error:", e);
        setMsg("Unexpected error finishing sign-in.");
      }
    })();
  }, [nav]);

  return (
    <div className="min-h-screen grid place-items-center bg-slate-950 text-slate-100 px-4 py-10">
      <div className="px-6 py-4 rounded-2xl bg-slate-900/80 border border-slate-700 max-w-xl text-center">
        {msg}
      </div>
    </div>
  );
}
