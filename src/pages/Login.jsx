// src/pages/Login.jsx
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import SigningInOverlay from "../components/SigningInOverlay";

export default function Login() {
  const { signin, googleSignIn } = useAuth();
  const nav = useNavigate();

  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [loadingPwd, setLoadingPwd] = useState(false);
  const [loadingGoogle, setLoadingGoogle] = useState(false);

  async function handlePassword(e) {
    e.preventDefault();
    setErr("");
    setLoadingPwd(true);
    try {
      await signin(email, pass);
      nav("/", { replace: true });
    } catch (error) {
      setErr(error?.message || "Sign-in failed.");
    } finally {
      setLoadingPwd(false);
    }
  }

  async function handleGoogle() {
    setErr("");
    setLoadingGoogle(true);
    try {
      await googleSignIn(); // pure OAuth sign-in (no linkIdentity)
      // redirects to /auth/callback via Supabase; no local nav() needed
    } catch (error) {
      setErr(error?.message || "Google sign-in failed.");
      setLoadingGoogle(false);
    }
  }

  if (loadingGoogle) {
    return <SigningInOverlay />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 text-slate-100">
      <div className="w-full max-w-md">
        <div className="surface-card p-6 sm:p-8 space-y-6">
          <div className="space-y-2">
            <img
              src="/smartquizlogo.png"
              alt="Smart-Quiz logo"
              className="h-9 w-auto object-contain drop-shadow-[0_6px_18px_rgba(0,0,0,0.35)] -ml-1"
              draggable="false"
            />
            <h1 className="text-2xl font-semibold">Welcome back</h1>
            <p className="text-white/70 text-sm">
              Sign in to keep your quizzes in sync across devices.
            </p>
          </div>

          <button
            onClick={handleGoogle}
            disabled={loadingGoogle}
            className="w-full rounded-2xl px-4 py-3 bg-white text-slate-900 font-semibold hover:bg-white/90 transition disabled:opacity-60"
          >
            {loadingGoogle ? "Opening Google…" : "Continue with Google"}
          </button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/10" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-3 bg-transparent text-white/60">or</span>
            </div>
          </div>

          <form onSubmit={handlePassword} className="space-y-4">
            {err && <p className="text-sm text-red-400">{err}</p>}
            <input
              className="field w-full"
              placeholder="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              className="field w-full"
              placeholder="Password"
              type="password"
              autoComplete="current-password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
            />
            <button
              disabled={loadingPwd}
              className="w-full px-4 py-3 rounded-2xl bg-emerald-500/90 hover:bg-emerald-400 text-slate-950 font-semibold transition disabled:opacity-60"
            >
              {loadingPwd ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <p className="text-sm text-white/70 text-center">
            No account?{" "}
            <Link to="/signup" className="text-emerald-300 hover:text-emerald-200 font-semibold">
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
