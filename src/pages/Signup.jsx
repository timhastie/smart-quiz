import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";

export default function Signup() {
  const { signup } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  async function handle(e) {
    e.preventDefault();
    setErr(""); setMsg("");
    const { error } = await signup(email, pass);
    if (error) setErr(error.message);
    else { setMsg("Check your email to confirm, then log in."); }
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
            <h1 className="text-2xl font-semibold">Create an account</h1>
            <p className="text-white/70 text-sm">
              Upgrade your guest session so your progress is always saved.
            </p>
          </div>

          <form onSubmit={handle} className="space-y-4">
            {err && <p className="text-sm text-red-400">{err}</p>}
            {msg && <p className="text-sm text-emerald-300">{msg}</p>}
            <input
              className="field w-full"
              placeholder="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              className="field w-full"
              placeholder="Password"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
            />
            <button className="w-full px-4 py-3 rounded-2xl bg-emerald-500/90 hover:bg-emerald-400 text-slate-950 font-semibold transition">
              Sign up
            </button>
          </form>

          <p className="text-sm text-white/70 text-center">
            Have an account?{" "}
            <Link to="/login" className="text-emerald-300 hover:text-emerald-200 font-semibold">
              Log in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
