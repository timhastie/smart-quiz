// src/auth/AuthCallback.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    (async () => {
      try {
        const url = new URL(window.location.href);
        const search = url.search;
        const hash = url.hash;

        const error = url.searchParams.get("error");
        const errorDesc =
          url.searchParams.get("error_description") ||
          url.searchParams.get("error_code") ||
          "";
        const rawCode =
          url.searchParams.get("code") ||
          url.searchParams.get("token") ||
          url.searchParams.get("auth_code") ||
          "";
        const guestFromUrl = url.searchParams.get("guest") || "";
        const guestFromLS = localStorage.getItem("guest_to_adopt") || "";

        console.log("[AuthCallback] URL params:", {
          search,
          hash,
          error,
          errorDesc,
          rawCode,
          guestFromUrl,
          guestFromLS,
        });

        // 1) Handle explicit OAuth error
        if (error) {
          const full = `Auth error: ${error}${
            errorDesc ? ` — ${decodeURIComponent(errorDesc)}` : ""
          }`;
          console.error("[AuthCallback] OAuth error:", full);
          setMsg(full);
          return;
        }

        // 2) Establish a session

        if (rawCode) {
          console.log("[AuthCallback] Exchanging auth code for session…");
          const { data, error: exchErr } =
            await supabase.auth.exchangeCodeForSession(rawCode);
          if (exchErr) {
            console.error("[AuthCallback] exchangeCodeForSession failed:", exchErr);
            setMsg(exchErr.message || "Could not finish sign-in.");
            return;
          }
          console.log("[AuthCallback] PKCE session:", {
            userId: data?.session?.user?.id,
            email: data?.session?.user?.email,
          });
        } else {
          console.log(
            "[AuthCallback] No code param; checking existing session (implicit/hash or already set)…"
          );
          const { data: s, error: sErr } = await supabase.auth.getSession();
          if (sErr) {
            console.error("[AuthCallback] getSession error:", sErr);
            setMsg("Could not read session after sign-in.");
            return;
          }
          if (!s.session?.user) {
            console.warn(
              "[AuthCallback] No session found after callback; remaining as guest."
            );
            setMsg("Missing auth code.");
            return;
          }
          console.log("[AuthCallback] Using existing session:", {
            id: s.session.user.id,
            email: s.session.user.email,
            providers: s.session.user.app_metadata?.providers,
          });
        }

        // 3) Now we should have a logged-in user
        const { data: ures, error: uErr } = await supabase.auth.getUser();
        if (uErr || !ures?.user) {
          console.error("[AuthCallback] getUser after session failed:", uErr);
          setMsg("Signed in, but could not load your account.");
          return;
        }
        const authed = ures.user;

        const oldId = (guestFromUrl || guestFromLS || "").trim();
        console.log("[AuthCallback] Final user:", {
          id: authed.id,
          email: authed.email,
          oldGuestId: oldId,
        });

        const providers = authed.app_metadata?.providers || [];
        const isAnon =
          authed.is_anonymous === true ||
          authed.user_metadata?.is_anonymous === true ||
          authed.app_metadata?.provider === "anonymous" ||
          (Array.isArray(providers) && providers.includes("anonymous"));

        // 4) If we came from a guest account, adopt its quizzes
        if (oldId && !isAnon && oldId !== authed.id) {
          console.log(
            "[AuthCallback] Running adopt_guest from",
            oldId,
            "→",
            authed.id
          );
          const { error: adoptErr } = await supabase.rpc("adopt_guest", {
            p_old_user: oldId,
          });
          if (adoptErr) {
            console.error("[AuthCallback] adopt_guest failed:", adoptErr);
            setMsg(
              "Signed in, but we couldn't automatically move your guest quizzes. You can keep using the app."
            );
          } else {
            console.log("[AuthCallback] adopt_guest succeeded.");
            setMsg(
              "Signed in! Your guest quizzes were moved to your account. Redirecting…"
            );
          }
          localStorage.removeItem("guest_to_adopt");
        } else {
          setMsg("Signed in. Redirecting…");
        }

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
      <div className="px-6 py-4 rounded-2xl bg-slate-900/80 border border-slate-700/80 max-w-xl text-center text-lg">
        {msg}
      </div>
    </div>
  );
}
