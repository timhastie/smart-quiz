// src/auth/AuthProvider.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// Build the callback URL; include the guest id when we have one
function buildRedirectURL(guestId) {
  const url = new URL(`${window.location.origin}/auth/callback`);
  if (guestId) url.searchParams.set("guest", guestId);
  return url.toString();
}

function onAuthCallbackPath() {
  try {
    return window.location.pathname.startsWith("/auth/callback");
  } catch {
    return false;
  }
}

// Heuristic: does this user look anonymous?
function isAnonymous(u) {
  if (!u) return false;
  const prov = u.app_metadata?.provider || null;
  const provs = Array.isArray(u.app_metadata?.providers)
    ? u.app_metadata.providers
    : [];
  return (
    u.is_anonymous === true ||
    u.user_metadata?.is_anonymous === true ||
    prov === "anonymous" ||
    provs.includes("anonymous") ||
    (Array.isArray(u.identities) &&
      u.identities.some((i) => i?.provider === "anonymous")) ||
    (!u.email && (provs.length === 0 || provs.includes("anonymous")))
  );
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // ---------------------------------------------------------------------------
  // 1) Bootstrap session
  //    - If there is an existing session, use it.
  //    - Otherwise create an anonymous session (except on /auth/callback).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let mounted = true;

    async function ensureSession() {
      try {
        const { data: sess, error } = await supabase.auth.getSession();
        if (error) {
          console.error("[AuthProvider] getSession error:", error);
        }
        if (mounted && sess?.session?.user) {
          setUser(sess.session.user);
          return;
        }

        // No session -> start anonymous (but NOT on /auth/callback)
        if (!onAuthCallbackPath()) {
          const { data: anonRes, error: anonErr } =
            await supabase.auth.signInAnonymously();
          if (anonErr) {
            console.error("Anonymous sign-in failed:", anonErr);
            if (mounted) setUser(null);
            return;
          }
          if (mounted) setUser(anonRes?.user ?? null);
        }
      } finally {
        if (mounted) setReady(true);
      }
    }

    ensureSession();

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_evt, session) => {
        if (!mounted) return;
        setUser(session?.user ?? null);
      }
    );

    return () => {
      mounted = false;
      try {
        listener?.subscription?.unsubscribe();
      } catch {
        // ignore
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 2) One-time adopt after login (fallback when callback didn't have ?guest=)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !user) return;
    const oldId = localStorage.getItem("guest_to_adopt");
    if (!oldId) return;
    if (isAnonymous(user)) return; // only adopt once we are non-anon

    (async () => {
      try {
        const { error } = await supabase.rpc("adopt_guest", {
          p_old_user: oldId,
        });
        if (error) {
          console.warn("adopt_guest (post-login) failed:", error);
          return;
        }
        localStorage.removeItem("guest_to_adopt");
      } catch (e) {
        console.warn("adopt_guest (post-login) threw:", e);
      }
    })();
  }, [ready, user?.id]);

  // ---------------------------------------------------------------------------
  // 3) Email/password: ALWAYS signUp (so they confirm email)
  //    - When anonymous, store guest id so callback / post-login can adopt.
  // ---------------------------------------------------------------------------
  async function signupOrLink(email, password) {
    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    if (current?.is_anonymous) {
      const oldGuestId = current.id;
      localStorage.setItem("guest_to_adopt", oldGuestId);
      const emailRedirectTo = buildRedirectURL(oldGuestId);

      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo },
      });
      if (error) throw error;
      return { signedUp: true, fallback: true };
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: buildRedirectURL(null) },
    });
    if (error) throw error;
    return { signedUp: true };
  }

  function signin(email, password) {
    return supabase.auth.signInWithPassword({ email, password });
  }

  // ---------------------------------------------------------------------------
  // 4) OAuth: link OR sign-in with adopt fallback
  //
  //    - If current user is anonymous:
  //        1) Remember guest id.
  //        2) Try linkIdentity(provider).
  //        3) If link succeeds -> done (guest upgraded in-place).
  //        4) If error "Identity is already linked to another user":
  //             fall back to signInWithOAuth, still passing guest id
  //             so AuthCallback/adopt_guest can migrate quizzes.
  //
  //    - If not anonymous (or no current user):
  //        just signInWithOAuth (standard).
  // ---------------------------------------------------------------------------
  async function oauthOrLink(provider) {
    const {
      data: { user: current } = {},
    } = await supabase.auth.getUser();

    // Case A: guest session -> try to upgrade / merge
    if (current && isAnonymous(current)) {
      const guestId = current.id;
      // mark for adopt_guest fallback
      try {
        localStorage.setItem("guest_to_adopt", guestId);
      } catch {
        // ignore storage issues
      }
      const redirectTo = buildRedirectURL(guestId);

      // 1) Try direct linkIdentity
      const { error: linkErr } = await supabase.auth.linkIdentity({
        provider,
        options: { redirectTo },
      });

      if (!linkErr) {
        // Success: the anonymous user now HAS that provider; same user id.
        // AuthCallback will complete the flow; quizzes already belong to this id.
        return { linked: true };
      }

      const msg = (linkErr?.message || "").toLowerCase();

      // 2) If that provider identity already belongs to another account,
      //    fall back to normal OAuth sign-in so user lands in that account,
      //    and use guestId for adopt_guest merge.
      if (
        msg.includes("identity is already linked to another user") ||
        msg.includes("already linked to another user")
      ) {
        const { error: signErr } = await supabase.auth.signInWithOAuth({
          provider,
          options: { redirectTo },
        });
        if (signErr) throw signErr;
        return { fallbackSignedIn: true };
      }

      // 3) Any other link error: bubble up so UI can show it.
      throw linkErr;
    }

    // Case B: not anonymous (existing user or none) -> regular OAuth sign-in
    // If there happens to be a guest_to_adopt lying around, include it so
    // callback can clean it up / merge as needed (harmless if unused).
    let guestId = null;
    try {
      guestId = localStorage.getItem("guest_to_adopt") || null;
    } catch {
      guestId = null;
    }
    const redirectTo = buildRedirectURL(guestId);

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo },
    });
    if (error) throw error;
    return { signedIn: true };
  }

  // ---------------------------------------------------------------------------
  // 5) Sign out -> start fresh anonymous session again
  // ---------------------------------------------------------------------------
  const signout = async () => {
    setReady(false);
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.error("signOut error:", e);
    }

    try {
      const { data: anonRes, error: anonErr } =
        await supabase.auth.signInAnonymously();
      if (anonErr) {
        console.error(
          "Failed to start anonymous session after sign out:",
          anonErr
        );
      }
      const { data } = await supabase.auth.getUser();
      setUser(data?.user ?? null);
    } finally {
      setReady(true);
    }
  };

  return (
    <AuthCtx.Provider
      value={{
        user,
        ready,
        signupOrLink,
        signin,
        oauthOrLink,
        signout,
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
