// src/pages/Play.jsx
import { useEffect, useState, useRef } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

/* ---------- Free local fuzzy helpers (cheap) ---------- */
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\b(the|a|an)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function lev(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}
function tokenJaccard(a, b) {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter || 1);
}
function localGrade(userRaw, expectedRaw) {
  const u = normalize(userRaw);
  const e = normalize(expectedRaw);
  if (!u || !e) return { pass: false, why: "empty" };
  if (u === e) return { pass: true, why: "exact-normalized" };
  const d = lev(u, e);
  const maxEdits = Math.max(1, Math.floor(Math.min(u.length, e.length) * 0.2));
  if (d <= maxEdits) return { pass: true, why: `lev<=${maxEdits}` };
  const j = tokenJaccard(u, e);
  if (j >= 0.66) return { pass: true, why: `jaccard-${j.toFixed(2)}` };
  return { pass: false, why: "local-failed" };
}

// --- Strict fact helpers (years / numbers / codes) ---
function norm(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function yearTokens(s) {
  const m = String(s || "").match(/\b(1[6-9]\d{2}|20\d{2})\b/g);
  return m ? m.map(Number) : [];
}
function numTokens(s) {
  const m = String(s || "").match(/-?\d+(\.\d+)?/g);
  return m ? m.map(x => x.trim()) : [];
}
function hexDecEqual(a, b) {
  const hexRe = /^(?:\$|0x)?[0-9a-f]+$/i;
  const toNum = (s) => {
    const t = String(s || "").trim();
    if (hexRe.test(t)) return parseInt(t.replace(/^\$|0x/i, ""), 16);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    return NaN;
  };
  const va = toNum(a), vb = toNum(b);
  return Number.isFinite(va) && va === vb;
}
function isStrictFact(question, expected) {
  const q = norm(question);
  const hasYear = yearTokens(expected).length > 0;
  const hasAnyNumber = numTokens(expected).length > 0;
  const qHints = /(when|what year|which year|date|how many|how much|what number|tempo|bpm|cc|control change|port|channel|track|bank|pattern|page|step)\b/;
  const shortCanon = norm(expected).split(" ").filter(Boolean).length <= 3;
  const codeLike = /0x|\$|\bcc\b|\bctl\b|\bbpm\b|\bhz\b|\bkhz\b|\bdb\b|\bms\b|\bs\b|\d/.test(
    String(expected).toLowerCase()
  );
  return hasYear || (hasAnyNumber && (qHints.test(q) || shortCanon || codeLike));
}
function strictFactCorrect(userAns, expected) {
  if (norm(userAns) === norm(expected) || hexDecEqual(userAns, expected)) return true;

  const expYears = yearTokens(expected);
  const usrYears = yearTokens(userAns);
  if (expYears.length === 1) return usrYears.length === 1 && usrYears[0] === expYears[0];

  const expNums = numTokens(expected);
  if (expNums.length > 0) {
    const usrNums = numTokens(userAns);
    if (usrNums.length !== expNums.length) return false;
    const a = [...expNums].sort().join(",");
    const b = [...usrNums].sort().join(",");
    return a === b;
  }
  return false;
}

export default function Play() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { quizId } = useParams();

  const [quiz, setQuiz] = useState(null);
  const [index, setIndex] = useState(0);

  // Per-question state
  const [answered, setAnswered] = useState([]);               // correct flags
  const [inputs, setInputs] = useState([]);                   // cached text per Q
  const [feedback, setFeedback] = useState("");               // UI message

  // Scoring/attempt state
  const [attempted, setAttempted] = useState([]);             // true once a Q has been submitted at least once
  const [firstTryCorrect, setFirstTryCorrect] = useState([]); // true only if FIRST submission was correct

  // Results modal
  const [showResult, setShowResult] = useState(false);
  const [scorePct, setScorePct] = useState(0);

  // Return jump
  const [returnIndex, setReturnIndex] = useState(null);

  // Input box
  const [input, setInput] = useState("");
  const areaRef = useRef(null);

  // Strict mode (persisted)
  const [strict, setStrict] = useState(
    () => localStorage.getItem("quizStrictMode") === "1"
  );
  useEffect(() => {
    localStorage.setItem("quizStrictMode", strict ? "1" : "0");
  }, [strict]);

  // Load quiz
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("quizzes")
        .select("title, questions, file_id")
        .eq("id", quizId)
        .eq("user_id", user.id)
        .single();
      if (!error && data) {
        const len = data.questions?.length ?? 0;
        setQuiz(data);
        setIndex(0);
        setAnswered(Array(len).fill(false));
        setInputs(Array(len).fill(""));
        setAttempted(Array(len).fill(false));
        setFirstTryCorrect(Array(len).fill(false));
        setReturnIndex(null);
        setInput("");
        setFeedback("");
        setShowResult(false);
      }
    })();
  }, [quizId, user.id]);

  const total = quiz?.questions?.length ?? 0;
  const current = total > 0 ? quiz?.questions?.[index] : null;
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const hasConfetti = scorePct >= 90;

  // Feedback helpers
  const isPositiveFeedback = feedback.startsWith("✅");
  const canContinue = /press\s*c\s*to\s*continue/i.test(feedback);

  // When switching questions, restore saved input & feedback
  useEffect(() => {
    if (!quiz) return;
    setInput(inputs[index] || "");
    setFeedback(answered[index] ? "✅ Correct! Press C to continue." : "");
  }, [index, quiz]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Unanswered (not attempted) earlier question detection ---
  const firstUnansweredBefore = attempted.slice(0, index).findIndex((v) => !v);
  const showGoToUnanswered = firstUnansweredBefore !== -1; // only if a prior Q has NOT been attempted

  function handleChange(val) {
    setInput(val);
    setInputs((arr) => {
      const next = arr.slice();
      next[index] = val;
      return next;
    });
  }

  // Save latest score for Dashboard (upsert by user_id+quiz_id)
  async function saveLatestScore(pct) {
    try {
      await supabase
        .from("quiz_scores")
        .upsert(
          { user_id: user.id, quiz_id: quizId, last_score: pct, updated_at: new Date().toISOString() },
          { onConflict: "user_id,quiz_id" }
        );
    } catch {
      // ignore persistence errors for now
    }
  }

  function maybeFinish(attemptedNext, firstTryNext) {
    if (!attemptedNext.every(Boolean)) return;
    const points = firstTryNext.filter(Boolean).length;
    const pct = total ? Math.round((points / total) * 100) : 0;
    setScorePct(pct);
    setShowResult(true);
    saveLatestScore(pct);
  }

  // Allow submission at any time (even if not all attempted)
  function submitQuizNow() {
    const points = firstTryCorrect.filter(Boolean).length;
    const pct = total ? Math.round((points / total) * 100) : 0;
    setScorePct(pct);
    setShowResult(true);
    saveLatestScore(pct);
  }

  async function submit(e) {
    e?.preventDefault?.();
    if (!current) return;

    const userAns = input.trim();
    const expected = String(current.answer ?? "");
    const question = String(current.prompt ?? "");
    let isCorrect = false;

    // 1) Strict mode (exact string)
    if (strict) {
      isCorrect = userAns === expected;
    } else {
      // 2) STRICT FACT GUARD: years/numbers/codes → exact only
      if (isStrictFact(question, expected)) {
        isCorrect = strictFactCorrect(userAns, expected);
        if (!isCorrect) setFeedback("Incorrect ❌ (this one requires the exact value)");
      } else {
        // 3) Non-fact: try cheap local fuzzy
        const local = localGrade(userAns, expected);
        if (local.pass) {
          isCorrect = true;
        } else {
          // 4) Fallback to server judge (LLM) for semantic fairness
          try {
            const { data: sessionRes } = await supabase.auth.getSession();
            const jwt = sessionRes?.session?.access_token;
            const res = await fetch(
              `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/grade-answer`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
                },
                body: JSON.stringify({
                  question,
                  expected,
                  user_answer: userAns,
                }),
              }
            );
            if (res.ok) {
              const out = await res.json();
              isCorrect = !!out.correct;
              if (!isCorrect) {
                setFeedback("Incorrect ❌ Press c to continue");
              }
            } else {
              setFeedback("Incorrect ❌ Press c to continue");
            }
          } catch {
            setFeedback("Incorrect ❌ Press c to continue");
          }
        }
      }
    }

    // ---- Track per-question state ----
    const attemptedNext = attempted.slice();
    const firstTryNext = firstTryCorrect.slice();
    const isFirstAttempt = !attemptedNext[index];

    attemptedNext[index] = true;
    if (isFirstAttempt) firstTryNext[index] = !!isCorrect;

    setAttempted(attemptedNext);
    setFirstTryCorrect(firstTryNext);

    if (isCorrect) {
      setAnswered((arr) => {
        const next = arr.slice();
        next[index] = true;
        return next;
      });
      setFeedback("✅ Correct! Press C to continue.");
    } else if (strict || isStrictFact(question, expected)) {
      setFeedback("Incorrect ❌ (exact value needed) Press c to continue");
    }

    maybeFinish(attemptedNext, firstTryNext);
  }

  function continueIfCorrect() {
    if (!canContinue) return;

    if (returnIndex !== null) {
      const dest = returnIndex;
      setReturnIndex(null);
      setFeedback("");
      setIndex(dest);
      areaRef.current?.blur();
      return;
    }

    setFeedback("");
    setIndex((i) => Math.min(i + 1, total - 1));
    areaRef.current?.blur();
  }

  function onKey(e) {
    const isC = e.key === "c" || e.key === "C";
    if (!isC) return;
    if (!canContinue) return;
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    e.preventDefault();
    continueIfCorrect();
  }

  function onTextAreaKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(e);
      return;
    }
    const isC = e.key === "c" || e.key === "C";
    if (isC && canContinue) {
      e.preventDefault();
      continueIfCorrect();
    }
  }

  function goPrev() {
    if (!isFirst) setIndex((i) => i - 1);
  }
  function goNext() {
    if (!isLast) setIndex((i) => i + 1);
  }
  function jumpToFirstUnanswered() {
    if (firstUnansweredBefore === -1) return;
    setReturnIndex(index);
    setIndex(firstUnansweredBefore);
    requestAnimationFrame(() => areaRef.current?.focus());
  }

  // Retake: reset per-question state but keep the loaded quiz
  function retake() {
    const len = quiz?.questions?.length ?? 0;
    setAnswered(Array(len).fill(false));
    setInputs(Array(len).fill(""));
    setAttempted(Array(len).fill(false));
    setFirstTryCorrect(Array(len).fill(false));
    setIndex(0);
    setReturnIndex(null);
    setInput("");
    setFeedback("");
    setShowResult(false);
  }

  // --- UI helpers / styles ---
  const pressAnim = "transition-transform duration-100 active:scale-95";
  const btnBase = "px-4 py-2 rounded text-sm sm:text-base disabled:opacity-50 disabled:cursor-not-allowed";
  const btnGray = `bg-gray-700 hover:bg-gray-600 ${pressAnim}`;
  const btnIndigo = `bg-indigo-600 hover:bg-indigo-500 ${pressAnim}`;

  // Force consistent/tall action height from the very start, independent of middle button presence.
  const actionH = "h-12 sm:h-14"; // adjust if you want even taller

  if (!quiz) return null;

  return (
    <div
      className="quiz-play min-h-screen bg-gray-900 text-white"
      onKeyDown={onKey}
      tabIndex={0}
    >
      <header className="flex items-center justify-between p-3 sm:p-4 border-b border-gray-800">
        <h1 className="text-lg sm:text-xl font-bold truncate pr-3">
          {quiz.title || "Quiz"}
        </h1>
        <Link to="/" className={`${btnBase} ${btnGray}`}>
          Back
        </Link>
      </header>

      <main className="max-w-2xl mx-auto p-4 sm:p-6 text-base sm:text-2xl">
        {current ? (
          <>
            <p className="mb-3 sm:mb-4 leading-snug">
              <span className="mr-2 inline-block w-14 text-right">
                {index + 1}/{total}
              </span>
              {current.prompt}
            </p>

            {/* On mobile: single column; from sm: two columns with a narrow action rail */}
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-3">
              {/* Row 1: Strict + Display answer (stack on mobile) */}
              <div className="col-start-1 flex flex-col sm:flex-row sm:items-center gap-2">
                <label className="inline-flex items-center gap-2 text-sm sm:text-base">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={strict}
                    onChange={(e) => setStrict(e.target.checked)}
                  />
                  <span className="text-gray-300">Strict mode</span>
                </label>

                <div className="sm:ml-auto">
                  <button
                    type="button"
                    className={`w-full sm:w-auto ${btnBase} ${btnGray}`}
                    onClick={() => {
                      const ans = String(current.answer ?? "");
                      handleChange(ans);
                      areaRef.current?.focus();
                    }}
                  >
                    Display answer
                  </button>
                </div>
              </div>
              <div className="hidden sm:block" />

              {/* Row 2: Textarea (col1) + Enter (col2) — Enter vertically centered beside textarea on ≥sm */}
              <form onSubmit={submit} className="contents">
                <textarea
                  ref={areaRef}
                  className="w-full p-4 rounded bg-white text-gray-900 border border-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-600 text-base sm:text-xl placeholder:text-gray-500"
                  value={input}
                  onChange={(e) => handleChange(e.target.value)}
                  placeholder="Type your answer and press Enter…"
                  onKeyDown={onTextAreaKeyDown}
                  rows={5}
                  inputMode="text"
                />
                <button
                  type="submit"
                  className={`sm:self-center sm:shrink-0 ${btnBase} ${btnGray} ${actionH} w-full sm:w-auto`}
                  aria-label="Submit answer"
                  title="Submit (same as pressing Enter)"
                >
                  Enter
                </button>
              </form>

              {/* Row 3: Action buttons — middle button is OUT of the DOM until needed */}
              <div className="col-start-1">
                <div
                  className={`grid grid-cols-1 ${
                    showGoToUnanswered ? "sm:grid-cols-3" : "sm:grid-cols-2"
                  } gap-2 items-stretch`}
                >
                  {/* Previous (always shown; disabled on first question) */}
                  <div className="w-full">
                    <button
                      type="button"
                      disabled={isFirst}
                      className={`w-full ${btnBase} ${btnGray} ${actionH}`}
                      onClick={goPrev}
                    >
                      Previous Question
                    </button>
                  </div>

                  {/* Go to Unanswered — completely hidden from DOM unless a prior Q is unattempted */}
                  {showGoToUnanswered && (
                    <div className="w-full">
                      <button
                        type="button"
                        className={`w-full ${btnBase} ${btnGray} ${actionH} text-center`}
                        onClick={jumpToFirstUnanswered}
                      >
                        Go to Unanswered Question
                      </button>
                    </div>
                  )}

                  {/* Next */}
                  <div className="w-full">
                    <button
                      type="button"
                      className={`w-full ${btnBase} ${btnGray} ${actionH}`}
                      onClick={goNext}
                      disabled={isLast}
                    >
                      Next Question
                    </button>
                  </div>
                </div>

                {/* Submit Quiz centered under the action row */}
                <div className="mt-2 flex justify-center">
                  <button
                    type="button"
                    onClick={submitQuizNow}
                    className={`px-5 py-2 rounded ${btnIndigo} text-sm sm:text-base`}
                    title="Submit the quiz now and see your score"
                  >
                    Submit Quiz
                  </button>
                </div>

                {/* Feedback sits below the buttons so it doesn't affect their height */}
                {feedback ? (
                  <p
                    className={`mt-2 text-base sm:text-lg ${
                      isPositiveFeedback ? "text-green-400" : "text-red-400"
                    }`}
                    aria-live="polite"
                  >
                    {feedback}
                  </p>
                ) : null}
              </div>

              <div className="hidden sm:block" />
            </div>
          </>
        ) : (
          <p className="text-gray-300">No questions yet. Add some in the editor.</p>
        )}
      </main>

      {/* Results Modal */}
      {showResult && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-3 sm:p-4 z-50">
          <div className="bg-gray-800 text-white rounded-2xl p-5 sm:p-6 max-w-md w-full max-h-[85vh] overflow-y-auto">
            <h2 className="text-xl sm:text-2xl font-bold mb-2">
              Your Score {hasConfetti ? "🎉" : ""}
            </h2>
            <p className="text-base sm:text-lg mb-6">
              You scored <span className="font-semibold">{scorePct}%</span> on this quiz.
            </p>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2">
              <button
                type="button"
                className={`${btnBase} ${btnGray} w-full sm:w-auto`}
                onClick={retake}
              >
                Retake Quiz
              </button>
              <button
                type="button"
                className={`${btnBase} ${btnIndigo} w-full sm:w-auto`}
                onClick={() => navigate("/")}
              >
                Return to Dashboard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
