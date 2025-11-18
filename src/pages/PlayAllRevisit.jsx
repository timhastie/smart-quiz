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

  const pressAnim = "transition-all duration-150 active:scale-[0.97]";
  const btnBase =
    "px-4 py-2 rounded-2xl font-semibold disabled:opacity-50 disabled:cursor-not-allowed";
  const btnGray = `bg-white/10 hover:bg-white/20 text-white ${pressAnim}`;
  const btnGreen = `bg-emerald-500/90 hover:bg-emerald-400 text-slate-950 ${pressAnim}`;

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
      <div className="min-h-screen flex items-center justify-center px-4 py-10 text-slate-100">
        <div className="surface-card p-6 sm:p-7 text-white/80">
          Loading all Revisit questions…
        </div>
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-10 text-slate-100">
        <div className="surface-card p-6 sm:p-8 text-center space-y-4 max-w-md">
          <div className="text-xl font-semibold">No Revisit questions yet</div>
          <p className="text-white/70">
            Mark questions to “Revisit” while playing quizzes. They’ll appear here across all groups.
          </p>
          <Link to="/" className={`${btnBase} ${btnGreen}`}>
            Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen text-slate-100 pb-16">
      <header className="sticky top-0 z-30 border-b border-white/5 bg-slate-950/80 backdrop-blur-md">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">
              Revisit
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">
              Revisit (All Groups)
            </h1>
          </div>
          <button
            onClick={() => nav(-1)}
            className={`${btnBase} ${btnGray}`}
          >
            Back
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        {/* Progress */}
        <div className="text-sm text-white/70 flex flex-wrap items-center gap-2">
          <span>
            Question {idx + 1} of {items.length}
          </span>
          {current?.sourceTitle ? (
            <span className="text-white/60">
              (from <span className="italic">{current.sourceTitle}</span>)
            </span>
          ) : null}
        </div>

        {/* Prompt */}
        <div className="surface-card p-5">
          <div className="text-lg sm:text-2xl font-semibold leading-7 text-white">
            {current.prompt}
          </div>
        </div>

        {/* Input + actions */}
        <div className="flex flex-col sm:flex-row gap-3 items-stretch">
          <textarea
            className="flex-1 min-h-[140px] field-textarea"
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
              className={`${btnBase} ${btnGreen}`}
              disabled={revealed}
            >
              Submit
            </button>
            <button
              onClick={() => setRevealed(true)}
              className={`${btnBase} ${btnGray}`}
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
            <div className="mt-2 surface-panel px-3 py-2">
              <div className="text-sm text-white/70">Accepted answer(s):</div>
              <div className="mt-1 text-white">
                {(current.answers || []).length
                  ? current.answers.join(" • ")
                  : "—"}
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={prev}
                className={`${btnBase} ${btnGray}`}
                disabled={idx === 0}
              >
                Previous
              </button>
              <button
                onClick={next}
                className={`${btnBase} ${btnGray}`}
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
