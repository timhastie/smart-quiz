// src/pages/SharedPlay.jsx
import { useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { storeGuestId } from "../auth/guestStorage";

/* ---------- Free local fuzzy helpers (same grading style as Play, but non-strict) ---------- */
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
  const m = a.length;
  const n = b.length;
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

const CONCEPT_GROUPS = [
  {
    id: "protect",
    keywords: [
      "protect",
      "protection",
      "guard",
      "guardian",
      "defend",
      "defense",
      "safeguard",
      "security",
    ],
  },
  {
    id: "meat-diet",
    keywords: [
      "meat",
      "prey",
      "preys",
      "flesh",
      "carnivore",
      "carnivores",
      "carnivorous",
      "meat eater",
      "meat-eating",
      "other animals",
    ],
  },
];

function conceptTags(str) {
  const tags = new Set();
  const tokens = new Set(str.split(" ").filter(Boolean));
  const haystack = ` ${str} `;

  for (const concept of CONCEPT_GROUPS) {
    for (const raw of concept.keywords) {
      const keyword = raw.trim();
      if (!keyword) continue;
      if (keyword.includes(" ")) {
        if (haystack.includes(` ${keyword} `)) {
          tags.add(concept.id);
          break;
        }
      } else if (tokens.has(keyword)) {
        tags.add(concept.id);
        break;
      }
    }
  }
  return tags;
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

  const userConcepts = conceptTags(u);
  const expectedConcepts = conceptTags(e);
  for (const tag of userConcepts) {
    if (expectedConcepts.has(tag)) {
      return { pass: true, why: `concept-${tag}` };
    }
  }
  return { pass: false, why: "local-failed" };
}

function computeIsAnon(u) {
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

export default function SharedPlay() {
  const { slug } = useParams();
  const areaRef = useRef(null);
  const { user, ready, signup } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [quiz, setQuiz] = useState(null);
  const [index, setIndex] = useState(0);

  const [inputs, setInputs] = useState([]);
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState("");

  const [attempted, setAttempted] = useState([]);
  const [firstTryCorrect, setFirstTryCorrect] = useState([]);

  const [showResult, setShowResult] = useState(false);
  const [scorePct, setScorePct] = useState(0);

  // Shared participant identity + score saving
  const [participantName, setParticipantName] = useState("");
  const [participantId, setParticipantId] = useState("");
  const [savingScore, setSavingScore] = useState(false);
  const [scoreSaved, setScoreSaved] = useState(false);
  const [scoreSaveError, setScoreSaveError] = useState("");

  // "Add to my quizzes" cloning state
  const [adding, setAdding] = useState(false);
  const [cloneError, setCloneError] = useState("");
  const [cloneSuccess, setCloneSuccess] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPass, setAuthPass] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState(
    "Sign up or sign in to save this quiz to your account."
  );

  const pressAnim = "transition-all duration-150 active:scale-[0.97]";
  const btnBase =
    "px-4 py-2 rounded-2xl font-semibold text-sm sm:text-base disabled:opacity-50 disabled:cursor-not-allowed";
  const btnGray = `bg-white/10 hover:bg-white/20 text-white ${pressAnim}`;
  const btnIndigo = `bg-sky-500/90 hover:bg-sky-400 text-slate-950 ${pressAnim}`;

  const isAnon = computeIsAnon(user);

  useEffect(() => {
    if (authModalOpen && user && !isAnon) {
      setAuthModalOpen(false);
      setAuthBusy(false);
      setAuthMessage(
        "Sign up or sign in to save this quiz to your account."
      );
    }
  }, [authModalOpen, isAnon, user]);

  // Create / load stable participant id + remembered name (must be a real UUID)
  useEffect(() => {
    try {
      const idKey = "smartquiz_shared_participant_id";
      let pid = localStorage.getItem(idKey);

      // If we previously stored "shared-<uuid>" or anything non-uuid, throw it away
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (!pid || !uuidRegex.test(pid)) {
        if (window.crypto?.randomUUID) {
          pid = window.crypto.randomUUID();
          localStorage.setItem(idKey, pid);
        } else {
          console.warn(
            "crypto.randomUUID is not available; cannot create a UUID participant id"
          );
          pid = "";
        }
      }

      setParticipantId(pid);

      const storedName = localStorage.getItem(
        "smartquiz_shared_participant_name"
      );
      if (storedName) {
        setParticipantName(storedName);
      }
    } catch {
      // ignore localStorage errors
    }
  }, []);

  // Load shared quiz
  useEffect(() => {
    let cancelled = false;

    async function loadSharedQuiz() {
      try {
        setLoading(true);
        setError("");

        // 1) Find the share link by slug
        const { data: linkRow, error: linkErr } = await supabase
          .from("quiz_share_links")
          .select("quiz_id, is_enabled")
          .eq("slug", slug)
          .maybeSingle();

        if (linkErr || !linkRow || linkRow.is_enabled === false) {
          if (!cancelled) {
            setError("This shared quiz link is invalid or has expired.");
            setLoading(false);
          }
          return;
        }

        // 2) Load the quiz itself (RLS must allow read via share link)
        const { data: quizRow, error: quizErr } = await supabase
          .from("quizzes")
          .select("id, title, questions")
          .eq("id", linkRow.quiz_id)
          .maybeSingle();

        if (quizErr || !quizRow) {
          if (!cancelled) {
            setError("Could not load the quiz for this link.");
            setLoading(false);
          }
          return;
        }

        const questions = Array.isArray(quizRow.questions)
          ? quizRow.questions
          : [];

        if (!cancelled) {
          const len = questions.length;

          setQuiz({
            id: quizRow.id,
            title: quizRow.title || "Shared Quiz",
            questions,
          });
          setIndex(0);
          setInputs(Array(len).fill(""));
          setInput("");
          setFeedback("");
          setAttempted(Array(len).fill(false));
          setFirstTryCorrect(Array(len).fill(false));
          setShowResult(false);
          setScorePct(0);
          setScoreSaved(false);
          setScoreSaveError("");
          setCloneError("");
          setCloneSuccess(false);
          setLoading(false);
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setError("Something went wrong loading this shared quiz.");
          setLoading(false);
        }
      }
    }

    loadSharedQuiz();

    return () => {
      cancelled = true;
    };
  }, [slug]);

  // When switching questions, restore saved input
  useEffect(() => {
    if (!quiz) return;
    setInput(inputs[index] || "");
    setFeedback("");
  }, [index, quiz, inputs]);

  if (loading) {
    return (
      <div className="quiz-play min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="surface-card px-6 py-4 rounded-3xl text-center">
          <p className="text-sm text-white/70">Loading shared quiz…</p>
        </div>
      </div>
    );
  }

  if (error || !quiz) {
    return (
      <div className="quiz-play min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
        <div className="surface-card max-w-md w-full px-6 py-5 rounded-3xl space-y-4 text-center">
          <h1 className="text-xl font-semibold">Shared quiz not available</h1>
          <p className="text-sm text-white/70">{error || "Quiz not found."}</p>
          <div className="flex justify-center">
            <Link to="/" className={`${btnBase} ${btnGray}`}>
              Go to Smart-Quiz home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const questionsArr = Array.isArray(quiz.questions) ? quiz.questions : [];
  const total = questionsArr.length;
  const current = total > 0 ? questionsArr[index] : null;

  const isFirst = index === 0;
  const isLast = index === total - 1;
  const hasConfetti = scorePct >= 90;

  function handleChange(val) {
    setInput(val);
    setInputs((arr) => {
      const next = arr.slice();
      next[index] = val;
      return next;
    });
  }

  async function submit(e) {
    e?.preventDefault?.();
    if (!current) return;

    const userAns = input.trim();
    const expected = String(current.answer ?? "");
    const question = String(current.prompt ?? "");

    if (!userAns) return;

    let isCorrect = false;

    const local = localGrade(userAns, expected);
    if (local.pass) {
      isCorrect = true;
    } else {
      try {
        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/grade-answer`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
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
        }
      } catch {
        // fall back to incorrect
      }
    }

    const attemptedNext = attempted.slice();
    const firstNext = firstTryCorrect.slice();
    const isFirstAttempt = !attemptedNext[index];

    attemptedNext[index] = true;
    if (isFirstAttempt) firstNext[index] = !!isCorrect;

    setAttempted(attemptedNext);
    setFirstTryCorrect(firstNext);

    setFeedback(
      isCorrect
        ? "✅ Correct! Press Next to continue."
        : "Incorrect ❌ Try again or press Next to move on."
    );
  }

  function onTextAreaKeyDown(e) {
    const k = e.key;
    if (k === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(e);
      return;
    }
  }

  function goPrev() {
    if (!isFirst) {
      setIndex((i) => i - 1);
      requestAnimationFrame(() => areaRef.current?.focus());
    }
  }

  function goNext() {
    if (!isLast) {
      setIndex((i) => i + 1);
      requestAnimationFrame(() => areaRef.current?.focus());
    }
  }

  function submitQuizNow() {
    const points = firstTryCorrect.filter(Boolean).length;
    const pctExact = total ? (points / total) * 100 : 0;
    const pctRounded = Math.round(pctExact);

    setScorePct(pctRounded);
    setShowResult(true);
    setScoreSaved(false);
    setScoreSaveError("");
  }

  function retake() {
    const len = questionsArr.length;
    setAttempted(Array(len).fill(false));
    setFirstTryCorrect(Array(len).fill(false));
    setInputs(Array(len).fill(""));
    setInput("");
    setIndex(0);
    setFeedback("");
    setScorePct(0);
    setShowResult(false);
    setScoreSaved(false);
    setScoreSaveError("");
    requestAnimationFrame(() => areaRef.current?.focus());
  }

  async function saveSharedScore() {
    if (!slug || !quiz) return;
    const trimmedName = participantName.trim();
    if (!trimmedName) {
      setScoreSaveError("Please enter a name before saving your score.");
      return;
    }
    if (!participantId) {
      setScoreSaveError(
        "Could not create a participant id. Please reload and try again."
      );
      return;
    }

    setSavingScore(true);
    setScoreSaveError("");

    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/record-shared-attempt`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            slug,
            participant_name: trimmedName,
            participant_user_id: participantId,
            score: scorePct,
          }),
        }
      );

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(txt || "Failed to save score");
      }

      try {
        localStorage.setItem(
          "smartquiz_shared_participant_name",
          trimmedName
        );
      } catch {
        // ignore
      }

      setScoreSaved(true);
    } catch (err) {
      console.error("Error saving shared score:", err);
      setScoreSaveError(
        "Could not save your score. Please try again in a moment."
      );
    } finally {
      setSavingScore(false);
    }
  }

  /* ---------- Clone shared quiz into current user's quizzes ---------- */
  async function cloneQuizForUser(currentUser) {
    if (!quiz || !currentUser) return;

    try {
      setAdding(true);
      setCloneError("");
      setCloneSuccess(false);

      const { data: newQuiz, error: insertErr } = await supabase
        .from("quizzes")
        .insert({
          user_id: currentUser.id,
          title: quiz.title,
          questions: quiz.questions,
        })
        .select()
        .single();

      if (insertErr || !newQuiz) {
        console.error("Error cloning quiz:", insertErr);
        setCloneError("Could not add this quiz to your account.");
        return;
      }

      // If they already finished this shared quiz, record their score
      if (showResult && typeof scorePct === "number") {
        try {
          await supabase.from("quiz_attempts").insert({
            user_id: currentUser.id,
            quiz_id: newQuiz.id,
            attempt_number: 1,
            score: Math.round(scorePct),
          });
        } catch (attemptErr) {
          console.error(
            "Error inserting initial attempt for cloned quiz:",
            attemptErr
          );
        }
      }

      setCloneSuccess(true);
    } catch (err) {
      console.error("Unexpected error cloning quiz:", err);
      setCloneError("Something went wrong while adding this quiz.");
    } finally {
      setAdding(false);
    }
  }

  async function handleAddToMyQuizzes() {
    if (!ready) return;
    if (!user) {
      setCloneError(
        "Could not detect your session. Please reload the page and try again."
      );
      return;
    }
    await cloneQuizForUser(user);
    if (computeIsAnon(user)) {
      setAuthModalOpen(true);
    }
  }

  async function handleCreateAccountShared() {
    try {
      setAuthBusy(true);
      const email = (authEmail || "").trim();
      const password = authPass || "";
      if (!email || !password) {
        setAuthMessage("Please enter both email and password.");
        setAuthBusy(false);
        return;
      }
      if (user && isAnon) {
        try {
          storeGuestId(user.id);
        } catch {}
      }
      const { error } = await signup(email, password);
      if (error) {
        setAuthMessage(error.message || "Failed to start signup.");
        return;
      }
      setAuthMessage("Check your email to confirm, then return to Smart-Quiz.");
      window.open("/", "_blank", "noopener");
    } catch (err) {
      setAuthMessage(err?.message || "Failed to start signup.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignInShared() {
    try {
      setAuthBusy(true);
      const email = (authEmail || "").trim();
      const password = authPass || "";
      if (!email || !password) {
        setAuthMessage("Please enter both email and password.");
        setAuthBusy(false);
        return;
      }
      let guestId = null;
      if (user && isAnon) {
        guestId = user.id;
        try {
          storeGuestId(user.id);
        } catch {}
      }
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        setAuthMessage(error.message || "Failed to sign in.");
        return;
      }
      if (guestId && data?.user?.id && data.user.id !== guestId) {
        try {
          await supabase.rpc("adopt_guest", { p_old_user: guestId });
        } catch (adoptErr) {
          console.error("adopt_guest RPC error after shared sign-in:", adoptErr);
        }
      }
      setAuthModalOpen(false);
      setAuthMessage("Sign up or sign in to save this quiz to your account.");
      setCloneSuccess(true);
    } catch (err) {
      setAuthMessage(err?.message || "Something went wrong during sign in.");
    } finally {
      setAuthBusy(false);
    }
  }

  return (
    <div className="quiz-play min-h-screen bg-slate-950 text-slate-100 pb-16">
      <header className="sticky top-0 z-30 border-b border-white/5 bg-slate-950/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto flex flex-wrap items-end justify-between gap-4 px-6 py-4 sm:items-center">
          <div className="flex flex-col items-start gap-2 pl-2 sm:flex-row sm:items-center sm:gap-3 sm:pl-0 flex-none">
            <img
              src="/smartquizlogo.png"
              alt="Smart-Quiz logo"
              className="h-9 sm:h-10 w-auto my-1 object-contain drop-shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
              draggable="false"
            />
            <div className="text-left w-full sm:w-auto min-w-0">
              <p className="text-xs uppercase tracking-[0.2em] text-white/60">
                Shared Quiz
              </p>
              <h1 className="text-2xl font-semibold tracking-tight truncate">
                {quiz.title || "Shared Quiz"}
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 text-sm flex-none">
            <Link
              to="/"
              className={`${btnBase} ${btnGray}`}
              title="Go to Smart-Quiz home"
            >
              Home
            </Link>
          </div>
        </div>
      </header>

      <main className="px-4 sm:px-6 py-8 flex justify-center">
        <div className="w-full max-w-[900px]">
          {current ? (
            <div className="surface-card p-5 sm:p-8 space-y-6 relative">
              <div>
                <p className="text-xs uppercase tracking-wide text-white/60">
                  Question {index + 1} / {questionsArr.length}
                </p>
                <p className="mt-2 text-lg sm:text-2xl font-semibold leading-snug">
                  {current.prompt}
                </p>
              </div>

              {/* TEXTAREA FRAME */}
              <div className="mb-3 lg:flex lg:items-center lg:gap-6">
                <form onSubmit={submit} className="lg:flex-1">
                  <textarea
                    ref={areaRef}
                    className="w-full h-56 p-4 rounded-lg bg-white text-gray-900 border border-gray-300 focus:outline-none_focus:ring-2 focus:ring-emerald-600 text-base sm:text-xl placeholder:text-gray-500"
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
                      onClick={submit}
                      className={`col-span-2 w-full ${btnBase} ${btnGray} h-12 flex items-center justify-center`}
                      aria-label="Submit answer"
                      title="Submit (same as pressing Enter)"
                    >
                      Enter
                    </button>
                  </div>
                </form>
                <div className="hidden lg:flex justify-center">
                  <button
                    type="button"
                    onClick={submit}
                    className={`${btnBase} ${btnGray} h-12 items-center justify-center w-[150px]`}
                    aria-label="Submit answer"
                    title="Submit (same as pressing Enter)"
                  >
                    Enter
                  </button>
                </div>
              </div>

              {/* NAV BUTTONS + SUBMIT */}
              <div className="mt-0">
                <div className="hidden sm:grid sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    disabled={isFirst}
                    className={`w-full ${btnBase} ${btnGray} h-12 sm:h-14 flex items-center justify-center`}
                    onClick={goPrev}
                  >
                    Previous Question
                  </button>

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

                {/* Feedback */}
                {feedback && (
                  <p
                    className={`mt-3 text-base sm:text-lg text-center ${
                      feedback.startsWith("✅")
                        ? "text-green-400"
                        : "text-red-400"
                    }`}
                    aria-live="polite"
                  >
                    {feedback}
                  </p>
                )}

                {/* Result */}
                {showResult && (
                  <div className="mt-6 text-center space-y-4">
                    <p className="text-base sm:text-lg">
                      You scored{" "}
                        <span className="font-semibold">{scorePct}%</span> on
                        this shared quiz.
                      {hasConfetti ? " 🎉" : ""}
                    </p>

                    {/* Optional: save score for quiz creator */}
                    <div className="max-w-md mx-auto space-y-3">
                      <p className="text-sm sm:text-base text-white/80">
                        If you want the quiz creator to see your score on their
                        scoreboard, enter your name and save your score.
                      </p>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          value={participantName}
                          onChange={(e) => {
                            setParticipantName(e.target.value);
                            setScoreSaveError("");
                          }}
                          className="flex-1 rounded-xl border border-white/10 bg-slate-900/60 px-3 py-2 text-sm sm:text-base text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-sky-500"
                          placeholder="Your name (for the scoreboard)"
                        />
                        <button
                          type="button"
                          onClick={saveSharedScore}
                          disabled={savingScore || scoreSaved}
                          className={`${btnBase} ${btnIndigo} w-full sm:w-auto`}
                        >
                          {scoreSaved
                            ? "Score saved"
                            : savingScore
                            ? "Saving…"
                            : "Save my score"}
                        </button>
                      </div>
                      {scoreSaveError && (
                        <p className="text-sm text-red-400">
                          {scoreSaveError}
                        </p>
                      )}
                      {scoreSaved && !scoreSaveError && (
                        <p className="text-sm text-emerald-400">
                          Your score has been saved to the creator&apos;s
                          scoreboard.
                        </p>
                      )}
                    </div>

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2 pt-2">
                      <button
                        type="button"
                        className={`${btnBase} ${btnGray} w-full sm:w-auto`}
                        onClick={retake}
                      >
                        Retake
                      </button>
                      <Link
                        to="/"
                        className={`${btnBase} ${btnIndigo} w-full sm:w-auto text-center`}
                      >
                        Go to Smart-Quiz
                      </Link>
                    </div>
                  </div>
                )}
              </div>

              {/* Add to my quizzes button (bottom-right of card) */}
              <div className="mt-6 flex flex-col items-end gap-1">
                <button
                  type="button"
                  className={`${btnBase} ${btnIndigo}`}
                  disabled={adding}
                  onClick={handleAddToMyQuizzes}
                >
                  {adding ? "Adding…" : "Add to my quizzes"}
                </button>
                {cloneError && (
                  <p className="text-xs text-red-400 text-right mt-1">
                    {cloneError}
                  </p>
                )}
                {cloneSuccess && (
                  <p className="text-xs text-emerald-400 text-right mt-1">
                    Quiz added to your current session. You&apos;ll see it on
                    your dashboard.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="surface-card p-5 sm:p-8 text-center space-y-4">
              <p className="text-white/70">
                This quiz doesn&apos;t have any questions yet.
              </p>
              <div className="flex justify-center">
                <Link
                  to="/"
                  className={`${btnBase} ${btnIndigo}`}
                  title="Return to Smart-Quiz"
                >
                  Go to Smart-Quiz
                </Link>
              </div>
            </div>
          )}
        </div>
      </main>

      {authModalOpen && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-[95]"
          onClick={() => {
            if (!authBusy) {
              setAuthModalOpen(false);
              setAuthMessage(
                "Sign up or sign in to save this quiz to your account."
              );
            }
          }}
          aria-modal="true"
          role="dialog"
        >
          <div
            className="w-full max-w-md surface-card p-6 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2">Sign up / sign in to save</h2>
            <p className="text-white/70 mb-4 text-sm">
              Create an account so this quiz stays with you on the dashboard.
              We&apos;ll keep this page open so you can keep practicing.
            </p>
            {authMessage && (
              <div className="mb-4 rounded-lg bg-emerald-900/30 border border-emerald-800 p-3 text-sm">
                {authMessage}
              </div>
            )}

            <label className="block text-sm text-white/70 mb-1" htmlFor="share-auth-email">
              Email
            </label>
            <input
              id="share-auth-email"
              className="field w-full mb-3"
              type="email"
              placeholder="you@example.com"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              autoFocus
            />

            <label className="block text-sm text-white/70 mb-1" htmlFor="share-auth-pass">
              Password
            </label>
            <input
              id="share-auth-pass"
              className="field w-full mb-4"
              type="password"
              placeholder="••••••••"
              value={authPass}
              onChange={(e) => setAuthPass(e.target.value)}
            />

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                className={`${btnBase} ${btnGray} w-full`}
                onClick={() => !authBusy && setAuthModalOpen(false)}
                disabled={authBusy}
              >
                Not now
              </button>
              <button
                className={`${btnBase} ${btnIndigo} w-full`}
                onClick={handleCreateAccountShared}
                disabled={authBusy}
              >
                {authBusy ? "Working…" : "Create account"}
              </button>
              <button
                className={`${btnBase} ${btnGray} w-full`}
                onClick={handleSignInShared}
                disabled={authBusy}
              >
                Sign in
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
