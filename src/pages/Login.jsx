import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";

export default function Login() {
  const { signin } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");

  async function handle(e) {
    e.preventDefault();
    setErr("");
    const { error } = await signin(email, pass);
    if (error) setErr(error.message);
    else nav("/");
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
      <form onSubmit={handle} className="w-full max-w-sm space-y-4 bg-gray-800 p-6 rounded-2xl shadow">
        <h1 className="text-2xl font-bold">Log in</h1>
        {err && <p className="text-red-400 text-sm">{err}</p>}
        <input className="w-full p-3 rounded text-black" placeholder="Email"
               value={email} onChange={e=>setEmail(e.target.value)} />
        <input className="w-full p-3 rounded text-black" placeholder="Password" type="password"
               value={pass} onChange={e=>setPass(e.target.value)} />
        <button className="w-full p-3 rounded bg-emerald-500 font-semibold hover:bg-emerald-600">Sign in</button>
        <p className="text-sm text-gray-300">No account? <Link to="/signup" className="text-emerald-400">Sign up</Link></p>
      </form>
    </div>
  );
}
