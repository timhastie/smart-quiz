// src/auth/AuthCallback.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

// DEBUG: expose client for console tests (safe in dev)
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

        // Prefer guest from URL, else from localStorage (used in guest→account flow)
        const guestFromUrl = url.searchParams.get("guest");
        let guestFromLS = null;
        try {
          guestFromLS = localStorage.getItem("guest_to_adopt");
        } catch {
          guestFromLS = null;
        }
        const oldGuestId = guestFromUrl || guestFromLS || null;

        console.log("[AuthCallback] URL params:", {
          error,
          errorDesc,
          rawCode,
          guestFromUrl,
          guestFromLS,
        });

        // -------------------------------------------------------------------
        // SPECIAL CASE: "Identity is already linked to another user"
        //
        // This happens when:
        // - We tried linkIdentity() for a guest, but that Google account
        //   already belongs to another Supabase user.
        //
        // Fix:
        // - Re-run OAuth as a normal sign-in so we land in the existing
        //   account, still passing the guest id so adopt_guest can migrate.
        // -------------------------------------------------------------------
        if (
          error &&
          /identity is already linked to another user/i.test(
            errorDesc || error
          )
        ) {
          console.log(
            "[AuthCallback] Detected 'identity already linked' error."
          );

          if (!oldGuestId) {
            console.warn(
              "[AuthCallback] No guest id available; cannot adopt. Showing error."
            );
            setMsg(
              "Auth error: that Google account is already linked to another user."
            );
            return;
          }

          // Make sure the marker persists for the next callback.
          try {
            localStorage.setItem("guest_to_adopt", oldGuestId);
          } catch {
            // ignore
          }

          setMsg(
            "That Google account is already linked. Signing you into it and moving your quizzes…"
          );

          const redirectTo = buildRedirectURL(oldGuestId);

          // IMPORTANT: this will redirect the browser again.
          // We hard-code "google" because that's your only OAuth provider here.
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
          return; // stop; browser is navigating
        }

        // -------------------------------------------------------------------
        // Generic error (not our special case)
        // -------------------------------------------------------------------
        if (error) {
          console.error("[AuthCallback] Auth error:", { error, errorDesc });
          setMsg(
            `Auth error: ${error}${
              errorDesc ? ` — ${errorDesc}` : ""
            }`
          );
          return;
        }

        if (!rawCode) {
          console.error("[AuthCallback] Missing auth code in callback URL.");
          setMsg("Missing auth code.");
          return;
        }

        // -------------------------------------------------------------------
        // 1) Finish Supabase PKCE flow
        // -------------------------------------------------------------------
        console.log("[AuthCallback] Exchanging code for session…");
        const { data: exchData, error: exchErr } =
          await supabase.auth.exchangeCodeForSession(rawCode);

        if (exchErr) {
          console.error(
            "[AuthCallback] exchangeCodeForSession error:",
            exchErr
          );
          setMsg(
            exchErr.message || "Could not finish sign-in. Please try again."
          );
          return;
        }

        const authedUser = exchData?.session?.user || exchData?.user || null;
        console.log("[AuthCallback] Session established for:", {
          id: authedUser?.id,
          email: authedUser?.email,
          providers: authedUser?.app_metadata?.providers,
        });

        // -------------------------------------------------------------------
        // 2) Guest adoption: move quizzes from oldGuestId -> new user
        // -------------------------------------------------------------------
        if (oldGuestId && authedUser?.id && oldGuestId !== authedUser.id) {
          console.log(
            "[AuthCallback] Considering adopt_guest for old id:",
            oldGuestId
          );

          // Optional guard: only bother if that guest actually has quizzes
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
            console.log(
              "[AuthCallback] Running adopt_guest from",
              oldGuestId,
              "to",
              authedUser.id
            );
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
                "[AuthCallback] adopt_guest succeeded. Cleaning local marker."
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
          } catch {
            // ignore
          }
        } else {
          setMsg("Signed in. Redirecting…");
        }

        // -------------------------------------------------------------------
        // 3) Go home
        // -------------------------------------------------------------------
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
