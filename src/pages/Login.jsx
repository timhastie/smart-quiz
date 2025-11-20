// src/pages/Login.jsx

import React, { useState } from "react";
import { useAuth } from "../auth/AuthProvider";

export default function Login() {
  const { signin, signup, googleSignIn } = useAuth();

  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const isSignIn = mode === "signin";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      if (isSignIn) {
        // EMAIL/PASSWORD SIGN-IN
        // This will:
        //  - remember the current guest id (LS_GUEST_ID)
        //  - call supabase.auth.signInWithPassword
        //  - redirect through /auth/callback so adopt_guest runs
        await signin(email, password);
        // signin() will redirect the browser to /auth/callback,
        // which then sends the user to "/" after adoption.
      } else {
        // EMAIL/PASSWORD SIGN-UP
        // This will:
        //  - remember current guest id in LS_GUEST_ID
        //  - send email confirmation link pointing at /auth/callback
        const { error: signUpError } = await signup(email, password);
        if (signUpError) {
          throw signUpError;
        }
        setMessage("Check your email for a confirmation link.");
      }
    } catch (err) {
      console.error("Auth error:", err);
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError("");
    setMessage("");
    setLoading(true);
    try {
      // This uses AuthProvider.oauthOrLink("google"):
      //  - stores current guest id in LS_GUEST_ID
      //  - signs out locally to avoid identity linking
      //  - redirects to /auth/callback where adopt_guest runs
      await googleSignIn();
      // No need to do anything else; browser will redirect.
    } catch (err) {
      console.error("Google sign-in error:", err);
      setError(err.message || "Google sign-in failed.");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white shadow-md rounded-lg p-6">
        <h1 className="text-2xl font-semibold text-slate-900 mb-4 text-center">
          {isSignIn ? "Sign in to SmartQuiz" : "Create your SmartQuiz account"}
        </h1>

        <div className="flex justify-center mb-4 space-x-2">
          <button
            type="button"
            onClick={() => {
              setMode("signin");
              setError("");
              setMessage("");
            }}
            className={`px-3 py-1 rounded text-sm ${
              isSignIn
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-700"
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("signup");
              setError("");
              setMessage("");
            }}
            className={`px-3 py-1 rounded text-sm ${
              !isSignIn
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-700"
            }`}
          >
            Sign Up
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="block text-sm font-medium text-slate-700">
              Email
            </span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
            />
          </label>

          <label className="block">
            <span className="block text-sm font-medium text-slate-700">
              Password
            </span>
            <input
              type="password"
              autoComplete={isSignIn ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
            />
          </label>

          {error && (
            <p className="text-sm text-red-600 whitespace-pre-line">{error}</p>
          )}
          {message && (
            <p className="text-sm text-emerald-600 whitespace-pre-line">
              {message}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 inline-flex items-center justify-center rounded-md border border-transparent bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2 disabled:opacity-60"
          >
            {loading
              ? isSignIn
                ? "Signing in..."
                : "Signing up..."
              : isSignIn
              ? "Sign In"
              : "Sign Up"}
          </button>
        </form>

        <div className="mt-6">
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="w-full inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
          >
            Continue with Google
          </button>
        </div>
      </div>
    </div>
  );
}
