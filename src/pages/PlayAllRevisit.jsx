// src/pages/PlayAllRevisit.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

/* --- lightweight local grader (matches your style) --- */
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function isCorrect(user, answers) {
  const u = normalize(user);
  const outs = (answers || []).map((a) => normalize(String(a || "")));
  if (!u) return false;
  // exact or contains either direction
  return outs.some((a) => a && (u === a || u.includes(a) || a.includes(u)));
}

export default function PlayAllRevisit() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [search] = useSearchParams(); // keeps ?mode=review that you already pass
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]); // [{prompt, answers}]
  const [idx, setIdx] = useState(0);
  const [input, setInput] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [result, setResult] = useState(null); // "correct" | "incorrect" | null

  const current = items[idx] || null;

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!user?.id) {
        setLoading(false);
        return;
      }
      // Pull all quizzes, gather review_questions across ALL groups
      const { data, error } = await supabase
        .from("quizzes")
        .select("id, title, review_questions")
        .eq("user_id", user.id);
      if (!alive) return;

      if (error) {
        console.error(error);
        setItems([]);
        setLoading(false);
        return;
      }
      const out = [];
      for (const q of data || []) {
        const arr = Array.isArray(q?.review_questions)
          ? q.review_questions
          : [];
        for (const rq of arr) {
          const prompt = (rq?.prompt || "").toString().trim();
          const answers = Array.isArray(rq?.answers) ? rq.answers : [];
          if (prompt) out.push({ prompt, answers, sourceQuizId: q.id, sourceTitle: q.title || "Untitled Quiz" });
        }
      }
      // Stable sort: keep latest reviewed last? Keep as-is for now
      setItems(out);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [user?.id]);

  // keyboard: Enter submits, "c" continues after reveal
  useEffect(() => {
    function onKey(e) {
      if (loading || !current) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (revealed) return; // already scored
        const ok = isCorrect(input, current.answers);
        setResult(ok ? "correct" : "incorrect");
        setRevealed(true);
      } else if ((e.key === "c" || e.key === "C") && revealed) {
        next();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, current, input, revealed]);

  function next() {
    setInput("");
    setRevealed(false);
    setResult(null);
    setIdx((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
  }
  function prev() {
    setInput("");
    setRevealed(false);
    setResult(null);
    setIdx((i) => Math.max(i - 1, 0));
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white grid place-items-center">
        <div className="text-gray-300">Loading all Revisit questions…</div>
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-6">
        <div className="text-xl font-semibold mb-2">No Revisit questions yet</div>
        <p className="text-gray-300 mb-6 text-center max-w-md">
          Mark questions to “Revisit” while playing quizzes. They’ll appear here across all groups.
        </p>
        <Link
          to="/"
          className="px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 transition"
        >
          Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="border-b border-gray-800 px-6 sm:px-8 lg:px-12 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">Revisit (All Groups)</h1>
          <button
            onClick={() => nav(-1)}
            className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 transition"
          >
            Back
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-6">
        {/* Progress */}
        <div className="text-sm text-gray-300 mb-3">
          Question {idx + 1} of {items.length}
          {current?.sourceTitle ? (
            <span className="ml-2 text-gray-400">
              (from: <span className="italic">{current.sourceTitle}</span>)
            </span>
          ) : null}
        </div>

        {/* Prompt */}
        <div className="bg-gray-800 rounded-2xl p-5 border border-gray-800 shadow">
          <div className="text-lg leading-7">{current.prompt}</div>
        </div>

        {/* Input + actions */}
        <div className="mt-4 flex flex-col sm:flex-row gap-3 items-stretch">
          <textarea
            className="flex-1 min-h-[120px] p-3 rounded bg-gray-800 text-white border border-gray-700"
            placeholder="Type your answer… (Press Enter to submit)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={revealed}
          />
          <div className="flex flex-col gap-2 w-full sm:w-48">
            <button
              onClick={() => {
                if (revealed) return;
                const ok = isCorrect(input, current.answers);
                setResult(ok ? "correct" : "incorrect");
                setRevealed(true);
              }}
              className="px-3 py-2 rounded bg-emerald-500 hover:bg-emerald-600 font-semibold transition"
              disabled={revealed}
            >
              Submit
            </button>
            <button
              onClick={() => setRevealed(true)}
              className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 transition"
              disabled={revealed}
              title="Show the model answer"
            >
              Display answer
            </button>
          </div>
        </div>

        {/* Feedback */}
        {revealed && (
          <div className="mt-3">
            {result === "correct" ? (
              <div className="rounded-lg bg-emerald-900/30 border border-emerald-800 px-3 py-2">
                ✅ Correct! Press <span className="font-semibold">C</span> to continue.
              </div>
            ) : (
              <div className="rounded-lg bg-red-900/30 border border-red-800 px-3 py-2">
                Incorrect ❌ Press <span className="font-semibold">C</span> to continue.
              </div>
            )}
            <div className="mt-2 rounded-lg bg-gray-800 border border-gray-700 px-3 py-2">
              <div className="text-sm text-gray-300">Accepted answer(s):</div>
              <div className="mt-1 text-white">
                {(current.answers || []).length
                  ? current.answers.join(" • ")
                  : "—"}
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={prev}
                className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 transition disabled:opacity-60"
                disabled={idx === 0}
              >
                Previous
              </button>
              <button
                onClick={next}
                className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 transition disabled:opacity-60"
                disabled={idx >= items.length - 1}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
