// src/pages/AuthCallback.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

if (typeof window !== "undefined") {
  window.__sb = supabase; // debug helper
}

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Finishing sign-in…");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const url = new URL(window.location.href);
        console.log("[AuthCallback] URL params:", Object.fromEntries(url.searchParams.entries()));

        const error = url.searchParams.get("error");
        const errorDesc = url.searchParams.get("error_description");

        // Supabase PKCE param
        const code =
          url.searchParams.get("code") ||
          url.searchParams.get("token") ||
          url.searchParams.get("auth_code");

        if (error) {
          const diagnostic = `Auth error: ${error}${
            errorDesc ? ` — ${errorDesc}` : ""
          }`;
          console.error("[AuthCallback]", diagnostic);
          if (!cancelled) setMsg(diagnostic);
          return;
        }

        if (!code) {
          console.error("[AuthCallback] Missing code in callback URL");
          if (!cancelled) setMsg("Missing auth code in callback. Please try again.");
          return;
        }

        console.log("[AuthCallback] Exchanging PKCE code for session…");
        const { data, error: exchErr } = await supabase.auth.exchangeCodeForSession(code);
        if (exchErr) {
          console.error("[AuthCallback] exchangeCodeForSession error:", exchErr);
          if (!cancelled)
            setMsg(exchErr.message || "Could not finish sign-in.");
          return;
        }

        console.log("[AuthCallback] exchangeCodeForSession OK:", {
          hasSession: !!data?.session,
          userId: data?.session?.user?.id,
        });

        const {
          data: { user: current },
        } = await supabase.auth.getUser();

        if (!current) {
          console.error("[AuthCallback] No user after exchange");
          if (!cancelled)
            setMsg("Signed in, but no session was found. Please try again.");
          return;
        }

        // -------- guest adoption logic --------
        const guestFromUrl = url.searchParams.get("guest");
        const guestFromLS = localStorage.getItem("guest_to_adopt");
        const oldId = guestFromUrl || guestFromLS || null;

        console.log("[AuthCallback] potential old guest:", {
          guestFromUrl,
          guestFromLS,
          using: oldId,
          currentUser: current.id,
        });

        if (oldId && oldId !== current.id) {
          // Optional: only adopt if that guest actually has quizzes
          const { count, error: cntErr } = await supabase
            .from("quizzes")
            .select("id", { count: "exact", head: true })
            .eq("user_id", oldId);

          if (cntErr) {
            console.warn("[AuthCallback] could not count old quizzes:", cntErr);
          }

          if (!cntErr && (count ?? 0) > 0) {
            console.log("[AuthCallback] adopting guest", oldId, "->", current.id);
            const { error: adoptErr } = await supabase.rpc("adopt_guest", {
              p_old_user: oldId,
            });
            if (adoptErr) {
              console.error("[AuthCallback] adopt_guest failed:", adoptErr);
              if (!cancelled) {
                setMsg(
                  "Signed in, but we couldn't automatically move your guest data. You can keep using the app."
                );
              }
            } else {
              if (!cancelled) {
                setMsg(
                  "Signed in! Your guest quizzes were moved to this account. Redirecting…"
                );
              }
            }
          } else {
            console.log(
              "[AuthCallback] no quizzes for old guest or count failed; skipping adopt."
            );
            if (!cancelled) setMsg("Signed in. Redirecting…");
          }
        } else {
          // No old guest or already same id (linkIdentity case)
          localStorage.removeItem("guest_to_adopt");
          if (!cancelled) setMsg("Signed in. Redirecting…");
        }

        // Clean URL so refresh won't redo callback.
        window.history.replaceState({}, document.title, "/");

        if (!cancelled) {
          nav("/", { replace: true });
        }
      } catch (e) {
        console.error("[AuthCallback] Unexpected error:", e);
        if (!cancelled)
          setMsg("Unexpected error finishing sign-in. Please try again.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nav]);

  return (
    <div className="min-h-screen grid place-items-center px-4 py-10 text-slate-100">
      <div className="surface-card p-6 sm:p-7 text-center text-white/80 max-w-md">
        {msg}
      </div>
    </div>
  );
}
