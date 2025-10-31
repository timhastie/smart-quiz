// src/pages/Play.jsx
import { useEffect, useState, useRef } from "react";
import { useParams, Link, useNavigate, useSearchParams } from "react-router-dom";
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
  const [sp] = useSearchParams();
  const isReviewMode = (sp.get("mode") || "").toLowerCase() === "review";

  const [quiz, setQuiz] = useState(null);
  const [index, setIndex] = useState(0);

  // Per-question state
  const [answered, setAnswered] = useState([]);               // correct flags
  const [inputs, setInputs] = useState([]);                   // cached text per Q
  const [feedback, setFeedback] = useState("");               // UI message

  // Scoring/attempt state
  const [attempted, setAttempted] = useState([]);             // tried at least once
  const [firstTryCorrect, setFirstTryCorrect] = useState([]); // first submission correct?

  // Results modal
  const [showResult, setShowResult] = useState(false);
  const [scorePct, setScorePct] = useState(0);

  // Return jump
  const [returnIndex, setReturnIndex] = useState(null);

  // Input box (current visible text)
  const [input, setInput] = useState("");
  const areaRef = useRef(null);

  // Strict mode (persisted)
  const [strict, setStrict] = useState(
    () => localStorage.getItem("quizStrictMode") === "1"
  );
  useEffect(() => {
    localStorage.setItem("quizStrictMode", strict ? "1" : "0");
  }, [strict]);

  // --- review-add prompt state ---
  const [showReviewPrompt, setShowReviewPrompt] = useState(false);
  const [addedToReview, setAddedToReview] = useState(false);

  // --- review-remove prompt state (for review mode) ---
  const [showRemovePrompt, setShowRemovePrompt] = useState(false);
  const [removedFromReview, setRemovedFromReview] = useState(false);

  // --- Peek state for "Display answer" toggle ---
  // peekOn[qIndex]: whether we are showing the correct answer in the textarea for that question
  const [peekOn, setPeekOn] = useState([]);
  // peekStash[qIndex]: the user's original text saved before we switched to the correct answer
  const [peekStash, setPeekStash] = useState([]);

  // Load quiz
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("quizzes")
        .select("title, questions, review_questions, file_id")
        .eq("id", quizId)
        .eq("user_id", user.id)
        .single();
      if (error || !data) return;

      const arr = isReviewMode ? (data.review_questions ?? []) : (data.questions ?? []);
      const len = arr.length;

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
      setShowReviewPrompt(false);
      setAddedToReview(false);
      setShowRemovePrompt(false);
      setRemovedFromReview(false);
      setPeekOn(Array(len).fill(false));
      setPeekStash(Array(len).fill(""));
    })();
  }, [quizId, user.id, isReviewMode]);

  // Helpers to access the active question set
  const questionsArr = isReviewMode ? (quiz?.review_questions ?? []) : (quiz?.questions ?? []);
  const total = questionsArr.length;
  const current = total > 0 ? questionsArr[index] : null;

  const isFirst = index === 0;
  const isLast = index === total - 1;
  const hasConfetti = scorePct >= 90;

  // Feedback helpers
  const isPositiveFeedback = feedback.startsWith("✅");
  const canContinue = /press\s*c\s*to\s*continue/i.test(feedback);

  // When switching questions, restore saved input & CLEAR feedback unless this Q is already correct
useEffect(() => {
  if (index == null) return;
  setInput((arr) => (Array.isArray(arr) ? arr[index] || "" : inputs[index] || ""));
  setFeedback(answered[index] ? "✅ Correct! Press C to continue." : "");
  setShowReviewPrompt(false);
  setAddedToReview(false);
  setShowRemovePrompt(false);
  setRemovedFromReview(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [index]);

  // --- Unanswered earlier question detection ---
  const firstUnansweredBefore = attempted.slice(0, index).findIndex((v) => !v);
  const showGoToUnanswered = firstUnansweredBefore !== -1;

  function handleChange(val) {
    setInput(val);
    setInputs((arr) => {
      const next = arr.slice();
      next[index] = val;
      return next;
    });
  }

  // Save latest score for Dashboard
  async function saveLatestScore(pct, { review = false } = {}) {
    try {
      const { data: existing } = await supabase
        .from("quiz_scores")
        .select("last_score, last_review_score")
        .eq("user_id", user.id)
        .eq("quiz_id", quizId)
        .maybeSingle();

      const now = new Date().toISOString();

      const payload = {
        user_id: user.id,
        quiz_id: quizId,
        updated_at: now,
        last_score: review ? (existing?.last_score ?? null) : pct,
        last_review_score: review ? pct : (existing?.last_review_score ?? null),
      };

      await supabase
        .from("quiz_scores")
        .upsert(payload, { onConflict: "user_id,quiz_id" });
    } catch {
      /* ignore */
    }
  }
  function maybeFinish(attemptedNext, firstTryNext) {
    if (!attemptedNext.every(Boolean)) return;
    const points = firstTryNext.filter(Boolean).length;
    const pct = total ? Math.round((points / total) * 100) : 0;
    setScorePct(pct);
    setShowResult(true);
    saveLatestScore(pct, { review: isReviewMode });
  }

  function submitQuizNow() {
    const points = firstTryCorrect.filter(Boolean).length;
    const pct = total ? Math.round((points / total) * 100) : 0;
    setScorePct(pct);
    setShowResult(true);
    saveLatestScore(pct, { review: isReviewMode });
  }

  // --- review helpers (add/remove) ---
  function alreadyInReview(prompt) {
    const rv = quiz?.review_questions ?? [];
    const key = (prompt || "").trim().toLowerCase();
    return rv.some((q) => (q?.prompt || "").trim().toLowerCase() === key);
  }

  async function addCurrentToReview() {
    if (!current) return;

    if (alreadyInReview(current.prompt)) {
      setAddedToReview(true);
      setShowReviewPrompt(false);
      return;
    }

    const rv = quiz?.review_questions ?? [];
    const newArr = [
      ...rv,
      { prompt: String(current.prompt ?? ""), answer: String(current.answer ?? "") },
    ];

    const { error } = await supabase
      .from("quizzes")
      .update({ review_questions: newArr, updated_at: new Date().toISOString() })
      .eq("id", quizId)
      .eq("user_id", user.id);

    if (!error) {
      setQuiz((prev) => (prev ? { ...prev, review_questions: newArr } : prev));
      setAddedToReview(true);
      setShowReviewPrompt(false);
    }
  }

  async function removeCurrentFromReview() {
    if (!current) return;

    const rv = quiz?.review_questions ?? [];
    const key = (current.prompt || "").trim().toLowerCase();
    const newArr = rv.filter((q) => (q?.prompt || "").trim().toLowerCase() !== key);

    const { error } = await supabase
      .from("quizzes")
      .update({ review_questions: newArr, updated_at: new Date().toISOString() })
      .eq("id", quizId)
      .eq("user_id", user.id);

    if (!error) {
      setQuiz((prev) => (prev ? { ...prev, review_questions: newArr } : prev));
      setRemovedFromReview(true);
      setShowRemovePrompt(false);

      const removedIdx = index;

      setAnswered((arr) => {
        const next = arr.slice();
        if (removedIdx >= 0 && removedIdx < next.length) next.splice(removedIdx, 1);
        return next;
      });
      setInputs((arr) => {
        const next = arr.slice();
        if (removedIdx >= 0 && removedIdx < next.length) next.splice(removedIdx, 1);
        return next;
      });
      setAttempted((arr) => {
        const next = arr.slice();
        if (removedIdx >= 0 && removedIdx < next.length) next.splice(removedIdx, 1);
        return next;
      });
      setFirstTryCorrect((arr) => {
        const next = arr.slice();
        if (removedIdx >= 0 && removedIdx < next.length) next.splice(removedIdx, 1);
        return next;
      });
      setPeekOn((arr) => {
        const next = arr.slice();
        if (removedIdx >= 0 && removedIdx < next.length) next.splice(removedIdx, 1);
        return next;
      });
      setPeekStash((arr) => {
        const next = arr.slice();
        if (removedIdx >= 0 && removedIdx < next.length) next.splice(removedIdx, 1);
        return next;
      });

      setIndex((prev) => {
        if (newArr.length === 0) return 0;
        const candidate = Math.min(removedIdx, newArr.length - 1);
        return candidate < 0 ? 0 : candidate;
      });
    }
  }

  async function submit(e) {
    e?.preventDefault?.();
    if (!current) return;

    const userAns = input.trim();
    const expected = String(current.answer ?? "");
    const question = String(current.prompt ?? "");
    let isCorrect = false;

    if (strict) {
      isCorrect = userAns === expected;
    } else {
      if (isStrictFact(question, expected)) {
        isCorrect = strictFactCorrect(userAns, expected);
        if (!isCorrect) setFeedback("Incorrect ❌ (this one requires the exact value)");
      } else {
        const local = localGrade(userAns, expected);
        if (local.pass) {
          isCorrect = true;
        } else {
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
                body: JSON.stringify({ question, expected, user_answer: userAns }),
              }
            );
            if (res.ok) {
              const out = await res.json();
              isCorrect = !!out.correct;
              if (!isCorrect) setFeedback("Incorrect ❌ Press c to continue");
            } else {
              setFeedback("Incorrect ❌ Press c to continue");
            }
          } catch {
            setFeedback("Incorrect ❌ Press c to continue");
          }
        }
      }
    }

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
      setShowReviewPrompt(false);
      setAddedToReview(false);

      // if it was peeking, keep the toggle state, but no need to change it here
      if (isReviewMode && alreadyInReview(current.prompt)) {
        setShowRemovePrompt(true);
        setRemovedFromReview(false);
      } else {
        setShowRemovePrompt(false);
        setRemovedFromReview(false);
      }
    } else {
      const canOfferAdd = !isReviewMode && !alreadyInReview(current.prompt);
      setShowReviewPrompt(canOfferAdd);
      setAddedToReview(false);
      setShowRemovePrompt(false);
      setRemovedFromReview(false);

      if (strict || isStrictFact(question, expected)) {
        setFeedback("Incorrect ❌ (exact value needed) Press c to continue");
      } else if (!/Press c to continue/i.test(feedback)) {
        setFeedback("Incorrect ❌ Press c to continue");
      }
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
    const k = e.key;
    const isC = k === "c" || k === "C";
    const isY = k === "y" || k === "Y";

    if (isY) {
      if (showReviewPrompt && !addedToReview) {
        e.preventDefault();
        addCurrentToReview();
        return;
      }
      if (showRemovePrompt && !removedFromReview) {
        e.preventDefault();
        removeCurrentFromReview();
        return;
      }
    }

    if (!isC) return;
    if (!canContinue) return;
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    e.preventDefault();
    continueIfCorrect();
  }

  function onTextAreaKeyDown(e) {
    const k = e.key;
    if (k === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(e);
      return;
    }
    const isC = k === "c" || k === "C";
    if (isC && canContinue) {
      e.preventDefault();
      continueIfCorrect();
      return;
    }
    const isY = k === "y" || k === "Y";
    if (isY) {
      if (showReviewPrompt && !addedToReview) {
        e.preventDefault();
        addCurrentToReview();
        return;
      }
      if (showRemovePrompt && !removedFromReview) {
        e.preventDefault();
        removeCurrentFromReview();
        return;
      }
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

  function retake() {
    const len = questionsArr.length;
    setAnswered(Array(len).fill(false));
    setInputs(Array(len).fill(""));
    setAttempted(Array(len).fill(false));
    setFirstTryCorrect(Array(len).fill(false));
    setIndex(0);
    setReturnIndex(null);
    setInput("");
    setFeedback("");
    setShowResult(false);
    setShowReviewPrompt(false);
    setAddedToReview(false);
    setShowRemovePrompt(false);
    setRemovedFromReview(false);
    setPeekOn(Array(len).fill(false));
    setPeekStash(Array(len).fill(""));
  }

  // --- Peek/toggle actions ---
  const isPeeking = !!peekOn[index];

  function toggleDisplayAnswer() {
    if (!current) return;
    const correct = String(current.answer ?? "");
    if (!isPeeking) {
      // Save user's current text and show the correct answer WITHOUT focusing textarea
      setPeekStash((arr) => {
        const next = arr.slice();
        next[index] = input;
        return next;
      });
      handleChange(correct);
      setPeekOn((arr) => {
        const next = arr.slice();
        next[index] = true;
        return next;
      });
      // IMPORTANT: no focus call here
    } else {
      // Restore user's original text
      const original = peekStash[index] ?? "";
      handleChange(original);
      setPeekOn((arr) => {
        const next = arr.slice();
        next[index] = false;
        return next;
      });
      // no focus
    }
  }

  // --- UI helpers / styles ---
  const pressAnim = "transition-transform duration-100 active:scale-95";
  const btnBase = "px-4 py-2 rounded text-sm sm:text-base disabled:opacity-50 disabled:cursor-not-allowed";
  const btnGray = `bg-gray-700 hover:bg-gray-600 ${pressAnim}`;
  const btnIndigo = `bg-indigo-600 hover:bg-indigo-500 ${pressAnim}`;

  if (!quiz) return null;

  return (
    <div
      className="quiz-play min-h-screen bg-gray-900 text-white"
      onKeyDown={onKey}
      tabIndex={0}
    >
      <header className="border-b border-gray-800 px-6 sm:px-8 lg:px-12 py-3 sm:py-4">
        {/* --- Desktop / tablet --- */}
        <div className="hidden sm:grid sm:grid-cols-3 sm:items-center">
          <h1 className="text-lg sm:text-xl font-bold truncate pr-3">
            {(quiz.title || "Quiz")}{isReviewMode ? " — Review" : ""}
          </h1>
          <div className="flex items-center justify-center">
            <img
              src="/smartquizlogo.png"
              alt="Smart-Quiz logo"
              className="h-12 sm:h-10 md:h-16 w-auto my-2 sm:my-3 object-contain select-none pointer-events-none"
              draggable="false"
            />
          </div>
          <div className="justify-self-end">
            <Link to="/" className={`${btnBase} ${btnGray}`} title="Go back to dashboard">
              Back
            </Link>
          </div>
        </div>

        {/* --- Mobile only --- */}
        <div className="sm:hidden">
          <div className="flex items-center justify-center mb-3">
            <img
              src="/smartquizlogo.png"
              alt="Smart-Quiz logo"
              className="h-12 w-auto my-1 object-contain select-none pointer-events-none"
              draggable="false"
            />
          </div>
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold truncate pr-3">
              {(quiz.title || "Quiz")}{isReviewMode ? " — Review" : ""}
            </h1>
            <Link to="/" className={`${btnBase} ${btnGray}`}>
              Back
            </Link>
          </div>
        </div>
      </header>

      <main className="px-4 sm:px-6 py-6 text-base sm:text-2xl">
        <div className="mx-auto w-full max-w-[900px]">
          {current ? (
            <>
              <div className="mx-auto w-full max-w-[740px]">
                <p className="mb-3 sm:mb-4 leading-snug">
                  <span className="mr-2">{index + 1}/{questionsArr.length}</span>
                  {current.prompt}
                </p>

                <div className="mb-3">
                  <div className="flex items-center justify-between">
                    <label
                      className="inline-flex items-center gap-2 text-sm sm:text-base"
                      title="Enable strict mode, only accept the exact answer."
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={strict}
                        onChange={(e) => setStrict(e.target.checked)}
                        title="Enable strict mode, only accept the exact answer."
                      />
                      <span className="text-gray-300">Strict mode</span>
                    </label>

                    {/* Desktop actions row */}
                    <div className="hidden sm:flex items-center gap-2">
                      {isReviewMode ? (
                        <Link
                          to={`/play/${quizId}`}
                          className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray}`}
                          title="Go to the main quiz (not the review set)"
                        >
                          Play Main Quiz
                        </Link>
                      ) : (
                        <Link
                          to={`/play/${quizId}?mode=review`}
                          className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray}`}
                          title="Practice only the questions in your review group"
                        >
                          Practice Revisit
                        </Link>
                      )}

                      {isReviewMode ? (
                        <button
                          type="button"
                          className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray}`}
                          onClick={removeCurrentFromReview}
                          disabled={!current || !alreadyInReview(current?.prompt)}
                          title={
                            !current
                              ? "No question"
                              : alreadyInReview(current?.prompt)
                              ? "Remove this from your review group"
                              : "Not in review group"
                          }
                        >
                          Remove from Review Group
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray}`}
                          onClick={addCurrentToReview}
                          disabled={!current || alreadyInReview(current?.prompt)}
                          title={
                            alreadyInReview(current?.prompt)
                              ? "Already added to review group"
                              : "Add this question to your review group"
                          }
                        >
                          Add To Review Group
                        </button>
                      )}

                      <button
                        type="button"
                        className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray}`}
                        onClick={toggleDisplayAnswer}
                        title={isPeeking ? "Show your original answer" : "Show the correct answer"}
                      >
                        {isPeeking ? "Display My Answer" : "Display answer"}
                      </button>
                    </div>
                  </div>

                  {/* Mobile-only actions */}
                  <div className="mt-2 grid grid-cols-3 gap-2 sm:hidden">
                    {isReviewMode ? (
                      <Link
                        to={`/play/${quizId}`}
                        className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray} min-h-14 py-3 whitespace-normal leading-normal`}
                        title="Go to the main quiz (not the review set)"
                      >
                        Play Main Quiz
                      </Link>
                    ) : (
                      <Link
                        to={`/play/${quizId}?mode=review`}
                        className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray} min-h-14 py-3 whitespace-normal leading-normal`}
                        title="Practice only the questions in your review group"
                      >
                        Practice Revisit
                      </Link>
                    )}

                    {isReviewMode ? (
                      <button
                        type="button"
                        className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray} min-h-14 py-3 whitespace-normal leading-normal`}
                        onClick={removeCurrentFromReview}
                        disabled={!current || !alreadyInReview(current?.prompt)}
                        title={
                          !current
                            ? "No question"
                            : alreadyInReview(current?.prompt)
                            ? "Remove this from your review group"
                            : "Not in review group"
                        }
                      >
                        Remove from Review Group
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray} min-h-14 py-3 whitespace-normal leading-normal`}
                        onClick={addCurrentToReview}
                        disabled={!current || alreadyInReview(current?.prompt)}
                        title={
                          alreadyInReview(current?.prompt)
                            ? "Already added to review group"
                            : "Add this question to your review group"
                        }
                      >
                        Add To Review Group
                      </button>
                    )}

                    <button
                      type="button"
                      className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray} min-h-14 py-3 whitespace-normal leading-normal`}
                      onClick={toggleDisplayAnswer}
                      title={isPeeking ? "Show your original answer" : "Show the correct answer"}
                    >
                      {isPeeking ? "Display My Answer" : "Display answer"}
                    </button>
                  </div>
                </div>

                {/* TEXTAREA FRAME */}
                <div className="relative mb-3">
                  <form onSubmit={submit}>
                    <textarea
                      ref={areaRef}
                      className="w-full h-56 p-4 rounded-lg bg-white text-gray-900 border border-gray-300
                           focus:outline-none focus:ring-2 focus:ring-emerald-600 text-base sm:text-xl
                           placeholder:text-gray-500"
                      value={input}
                      onChange={(e) => handleChange(e.target.value)}
                      placeholder="Type your answer and press Enter…"
                      onKeyDown={onTextAreaKeyDown}
                      rows={7}
                      inputMode="text"
                    />

                    {/* Mobile Enter/Prev/Next */}
                    <div className="mt-3 grid grid-cols-4 gap-3 sm:hidden">
                      <button
                        type="button"
                        disabled={isFirst}
                        onClick={goPrev}
                        className={`col-span-1 w-full ${btnBase} ${btnGray} h-12 flex items-center justify-center`}
                      >
                        Previous
                      </button>

                      <button
                        type="button"
                        disabled={isLast}
                        onClick={goNext}
                        className={`col-span-1 w-full ${btnBase} ${btnGray} h-12 flex items-center justify-center`}
                      >
                        Next
                      </button>

                      <button
                        type="button"
                        onClick={(e) => submit(e)}
                        className={`col-span-2 w-full ${btnBase} ${btnGray} h-12 flex items-center justify-center`}
                        aria-label="Submit answer"
                        title="Submit (same as pressing Enter)"
                      >
                        Enter
                      </button>
                    </div>
                  </form>

                  {/* Desktop side Enter */}
                  <button
                    type="button"
                    onClick={(e) => submit(e)}
                    className={`hidden lg:flex ${btnBase} ${btnGray} h-12 items-center justify-center
        absolute top-1/2 -translate-y-1/2 left-full ml-3`}
                    aria-label="Submit answer"
                    title="Submit (same as pressing Enter)"
                  >
                    Enter
                  </button>
                </div>

                {/* NAV BUTTONS */}
                <div className="mt-0">
                  <div className={`hidden sm:grid ${showGoToUnanswered ? "sm:grid-cols-3" : "sm:grid-cols-2"} gap-3`}>
                    <button
                      type="button"
                      disabled={isFirst}
                      className={`w-full ${btnBase} ${btnGray} h-12 sm:h-14 flex items-center justify-center`}
                      onClick={goPrev}
                    >
                      Previous Question
                    </button>

                    {showGoToUnanswered && (
                      <button
                        type="button"
                        className={`w-full ${btnBase} ${btnGray} h-12 sm:h-14 flex items-center justify-center`}
                        onClick={jumpToFirstUnanswered}
                      >
                        Go to Unanswered Question
                      </button>
                    )}

                    <button
                      type="button"
                      className={`w-full ${btnBase} ${btnGray} h-12 sm:h-14 flex items-center justify-center`}
                      onClick={goNext}
                      disabled={isLast}
                    >
                      Next Question
                    </button>
                  </div>

                  {/* Submit Quiz */}
                  <div className="mt-8 sm:mt-12 flex justify-center">
                    <button
                      type="button"
                      onClick={submitQuizNow}
                      className={`px-5 py-2 rounded ${btnIndigo} text-sm sm:text-base`}
                      title="Submit the quiz now and see your score"
                    >
                      Submit Quiz
                    </button>
                  </div>

                  {/* Feedback + prompts */}
                  {feedback && (
                    <p
                      className={`mt-3 text-base sm:text-lg text-center ${isPositiveFeedback ? "text-green-400" : "text-red-400"}`}
                      aria-live="polite"
                    >
                      {feedback}
                    </p>
                  )}

                  {showReviewPrompt && !addedToReview && (
                    <p className="mt-2 text-white text-center text-base sm:text-lg">
                      Add question to review group? Press <span className="font-semibold">Y</span> for yes.
                    </p>
                  )}
                  {!showReviewPrompt && addedToReview && (
                    <p className="mt-2 text-white text-center text-base sm:text-lg">Added to review group!</p>
                  )}

                  {isReviewMode && showRemovePrompt && !removedFromReview && (
                    <p className="mt-2 text-white text-center text-base sm:text-lg">
                      Remove question from review group? Press <span className="font-semibold">Y</span> for yes.
                    </p>
                  )}
                  {isReviewMode && !showRemovePrompt && removedFromReview && (
                    <p className="mt-2 text-white text-center text-base sm:text-lg">Removed question from review group.</p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="text-gray-300 text-center">No questions yet. Add some in the editor.</p>
              {isReviewMode && (
                <div className="mt-4 flex justify-center">
                  <Link
                    to={`/play/${quizId}`}
                    className={`${btnBase} ${btnIndigo}`}
                    title="Return to the main quiz"
                  >
                    Return to Main Quiz
                  </Link>
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {/* Results Modal */}
      {showResult && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-3 sm:p-4 z-50">
          <div className="bg-gray-800 text-white rounded-2xl p-5 sm:p-6 max-w-md w-full max-h-[85vh] overflow-y-auto">
            <h2 className="text-xl sm:text-2xl font-bold mb-2">
              {isReviewMode ? "Revisit Score" : "Your Score"} {hasConfetti ? "🎉" : ""}
            </h2>
            <p className="text-base sm:text-lg mb-6">
              You scored <span className="font-semibold">{scorePct}%</span> on this {isReviewMode ? "revisit set" : "quiz"}.
            </p>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2">
              <button type="button" className={`${btnBase} ${btnGray} w-full sm:w-auto`} onClick={retake}>
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
