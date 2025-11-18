// src/pages/Play.jsx
import { useEffect, useState, useRef } from "react";
import {
  useParams,
  Link,
  useNavigate,
  useSearchParams,
  useLocation,
} from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { getInitialGroupFromUrlOrStorage } from "../lib/groupFilter";

// --- Sentinel for the ALL bucket ---
const ALL_GROUP_ID = "00000000-0000-0000-0000-000000000000";

// Rounded INT write + verify row (REVISIT score)
async function saveGroupRevisitScore(userId, { scope, groupId, percentExact }) {
  try {
    if (!userId || typeof percentExact !== "number") return;
    if (scope !== "all" && scope !== "group") return;

    const percentInt = Math.round(percentExact);
    const gid =
      scope === "all"
        ? ALL_GROUP_ID
        : groupId && groupId !== "null" && groupId !== ""
        ? groupId
        : null;
    if (scope === "group" && !gid) return;

    const payload = {
      user_id: userId,
      scope, // 'group' | 'all'
      group_id: gid, // ALL_GROUP_ID for 'all', sentinel for “No group”
      last_review_score: percentInt,
      updated_at: new Date().toISOString(),
    };


    const { error: upErr } = await supabase
      .from("group_scores")
      .upsert(payload, { onConflict: "user_id,scope,group_id" });

    if (upErr) {
      return;
    }

    const { data: row, error: readErr } = await supabase
      .from("group_scores")
      .select("user_id, scope, group_id, last_review_score, updated_at")
      .eq("user_id", userId)
      .eq("scope", scope)
      .eq("group_id", gid)
      .single();

    if (readErr) return;
  } catch (e) {
    // ignore
  }
}

// Rounded INT write + verify row (ALL-QUESTIONS score)
async function saveGroupAllScore(userId, { scope, groupId, percentExact }) {
  try {
    if (!userId || typeof percentExact !== "number") return;
    if (scope !== "all" && scope !== "group") return;

    const percentInt = Math.round(percentExact);
    const gid =
      scope === "all"
        ? ALL_GROUP_ID
        : groupId && groupId !== "null" && groupId !== ""
        ? groupId
        : null;
    if (scope === "group" && !gid) return;

    const payload = {
      user_id: userId,
      scope,
      group_id: gid,
      last_all_score: percentInt,
      updated_at: new Date().toISOString(),
    };


    const { error: upErr } = await supabase
      .from("group_scores")
      .upsert(payload, { onConflict: "user_id,scope,group_id" });

    if (upErr) {
      return;
    }

    const { data: row, error: readErr } = await supabase
      .from("group_scores")
      .select("user_id, scope, group_id, last_all_score, updated_at")
      .eq("user_id", userId)
      .eq("scope", scope)
      .eq("group_id", gid)
      .single();

    if (readErr) return;
  } catch (e) {
    // ignore
  }
}

// Placeholder for forthcoming SQL change to store “All Questions” scores per Group/All
async function saveGroupAllQuestionsScore(/* userId, { scope, groupId, percentExact } */) {
  // intentionally left blank
}

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
  const m = a.length,
    n = b.length;
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
  return m ? m.map((x) => x.trim()) : [];
}
function hexDecEqual(a, b) {
  const hexRe = /^(?:\$|0x)?[0-9a-f]+$/i;
  const toNum = (s) => {
    const t = String(s || "").trim();
    if (hexRe.test(t)) return parseInt(t.replace(/^\$|0x/i, ""), 16);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    return NaN;
  };
  const va = toNum(a),
    vb = toNum(b);
  return Number.isFinite(va) && va === vb;
}
function isStrictFact(question, expected) {
  const q = norm(question);
  const hasYear = yearTokens(expected).length > 0;
  const hasAnyNumber = numTokens(expected).length > 0;
  const qHints =
    /(when|what year|which year|date|how many|how much|what number|tempo|bpm|cc|control change|port|channel|track|bank|pattern|page|step)\b/;
  const shortCanon =
    norm(expected).split(" ").filter(Boolean).length <= 3;
  const codeLike = /0x|\$|\bcc\b|\bctl\b|\bbpm\b|\bhz\b|\bkhz\b|\bdb\b|\bms\b|\bs\b|\d/.test(
    String(expected).toLowerCase()
  );
  return (
    hasYear || (hasAnyNumber && (qHints.test(q) || shortCanon || codeLike))
  );
}
function strictFactCorrect(userAns, expected) {
  if (norm(userAns) === norm(expected) || hexDecEqual(userAns, expected))
    return true;
  const expYears = yearTokens(expected);
  const usrYears = yearTokens(userAns);
  if (expYears.length === 1)
    return usrYears.length === 1 && usrYears[0] === expYears[0];
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

  // Support /play/:quizId, /play/group/:groupId?mode=..., and /play/all?mode=...
  const { quizId, groupId } = useParams();
  const [sp] = useSearchParams();
  const location = useLocation();
  const [normalizedGroupId, setNormalizedGroupId] = useState(() => groupId || "");
  const normalizedGroupIdRef = useRef(normalizedGroupId);
  useEffect(() => {
    normalizedGroupIdRef.current = normalizedGroupId;
  }, [normalizedGroupId]);
  useEffect(() => {
    setNormalizedGroupId(groupId || "");
  }, [groupId]);

  const modeParam = (sp.get("mode") || "").toLowerCase(); // "review" | "all"
  const wantsReview = modeParam === "review";
  const wantsAllQuestions =
    modeParam === "all" || modeParam === "questions" || modeParam === "full";

  const isGroupMode = !!groupId;
  const isAllMode = location.pathname.startsWith("/play/all");
  const isSyntheticMode = isGroupMode || isAllMode;

  const backPath = (() => {
    if (isGroupMode) {
      const fallback = normalizedGroupId || groupId || "";
      return fallback ? `/?group=${encodeURIComponent(fallback)}` : "/";
    }
    if (isAllMode) {
      return "/";
    }
    const last = getInitialGroupFromUrlOrStorage("");
    return last ? `/?group=${encodeURIComponent(last)}` : "/";
  })();

  // For SINGLE quiz: default to main (questions) unless ?mode=review
  // For SYNTHETIC: default to REVIEW if mode is missing/invalid.
  const isReviewMode = isSyntheticMode
    ? wantsReview || !wantsAllQuestions
    : wantsReview;
  const isAllQuestionsMode = isSyntheticMode
    ? wantsAllQuestions
    : !isReviewMode;

  const [quiz, setQuiz] = useState(null);
  const [index, setIndex] = useState(0);
  const [furthestIndex, setFurthestIndex] = useState(0);

  // Per-question state
  const [answered, setAnswered] = useState([]);
  const [inputs, setInputs] = useState([]);
  const [feedback, setFeedback] = useState("");

  // Scoring/attempt state
  const [attempted, setAttempted] = useState([]);
  const [firstTryCorrect, setFirstTryCorrect] = useState([]);

  // Results modal
  const [showResult, setShowResult] = useState(false);
  const [scorePct, setScorePct] = useState(0);

  // Return jump (used with Go-to-Unanswered)
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

  // --- Peek state ---
  const [peekOn, setPeekOn] = useState([]);
  const [peekStash, setPeekStash] = useState([]);

  // Load quiz (single, group synthetic, or all synthetic)
  useEffect(() => {
    if (!user?.id) return;

    (async () => {
      // --- ALL synthetic ---
      if (isAllMode) {
        const { data: rows, error } = await supabase
          .from("quizzes")
          .select("id, title, questions, review_questions")
          .eq("user_id", user.id)
          .order("updated_at", { ascending: false });

        if (error) {
          setQuiz({
            title: isReviewMode ? "All — Revisit" : "All — All Questions",
            questions: [],
            review_questions: [],
          });
        }

        const merged = [];
        for (const row of rows || []) {
          const arr = isReviewMode
            ? Array.isArray(row?.review_questions)
              ? row.review_questions
              : []
            : Array.isArray(row?.questions)
            ? row.questions
            : [];
          for (const q of arr) {
            merged.push({
              prompt: String(q?.prompt ?? ""),
              answer: String(q?.answer ?? ""),
              __srcQuizId: row.id,
              __srcTitle: row.title || "Untitled Quiz",
            });
          }
        }

        const title = isReviewMode
          ? "All — Revisit"
          : "All — All Questions";
        const synthetic = isReviewMode
          ? { title, questions: [], review_questions: merged, file_id: null }
          : { title, questions: merged, review_questions: [], file_id: null };

        const len = merged.length;

        setQuiz(synthetic);
        setIndex(0);
        setFurthestIndex(0);
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
        return;
      }

      // --- GROUP synthetic ---
      if (isGroupMode) {
        const resolvedGroupId = groupId || "";
        setNormalizedGroupId(resolvedGroupId);

        let groupMeta = null;
        if (resolvedGroupId) {
          const { data: g } = await supabase
            .from("groups")
            .select("id,name")
            .eq("user_id", user.id)
            .eq("id", resolvedGroupId)
            .maybeSingle();
          groupMeta = g ?? null;
        }

        let q = supabase
          .from("quizzes")
          .select("id, title, questions, review_questions, group_id")
          .eq("user_id", user.id)
          .order("updated_at", { ascending: false });

        if (resolvedGroupId) {
          q = q.eq("group_id", resolvedGroupId);
        }
        const { data: qs, error: qsErr } = await q;

        const merged = [];
        const rows = qsErr ? [] : qs || [];
        for (const row of rows) {
          const arr = isReviewMode
            ? Array.isArray(row?.review_questions)
              ? row.review_questions
              : []
            : Array.isArray(row?.questions)
            ? row.questions
            : [];
          for (const qq of arr) {
            merged.push({
              prompt: String(qq?.prompt ?? ""),
              answer: String(qq?.answer ?? ""),
              __srcQuizId: row.id,
              __srcTitle: row.title || "Untitled Quiz",
            });
          }
        }

        const groupLabel = groupMeta?.name ?? "Group";
        const title = isReviewMode
          ? `${groupLabel} — Revisit`
          : `${groupLabel} — All Questions`;
        const synthetic = isReviewMode
          ? { title, questions: [], review_questions: merged, file_id: null }
          : { title, questions: merged, review_questions: [], file_id: null };

        const len = merged.length;

        setQuiz(synthetic);
        setIndex(0);
        setFurthestIndex(0);
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
        return;
      }

      // --- SINGLE QUIZ ---
      const { data, error } = await supabase
        .from("quizzes")
        .select("title, questions, review_questions, file_id")
        .eq("id", quizId)
        .eq("user_id", user.id)
        .single();

      if (error || !data) {
        setQuiz({ title: "Quiz", questions: [], review_questions: [] });
      }

      const arr = isReviewMode
        ? data?.review_questions ?? []
        : data?.questions ?? [];
      const len = arr.length;

      setQuiz(data || { title: "Quiz", questions: [], review_questions: [] });
      setIndex(0);
      setFurthestIndex(0);
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
  }, [
    quizId,
    groupId,
    user?.id,
    isReviewMode,
    isGroupMode,
    isAllMode,
    isAllQuestionsMode,
  ]);

  // Helpers to access the active question set
  const questionsArr = isReviewMode
    ? quiz?.review_questions ?? []
    : quiz?.questions ?? [];
  const total = questionsArr.length;
  const current = total > 0 ? questionsArr[index] : null;

  const isFirst = index === 0;
  const isLast = index === total - 1;
  const hasConfetti = scorePct >= 90;

  // Feedback helpers
  const isPositiveFeedback = feedback.startsWith("✅");
  const canContinue = /press\s*c\s*to\s*continue/i.test(feedback);

  // When switching questions: restore saved input & feedback
  useEffect(() => {
    if (index == null) return;
    setInput((arr) =>
      Array.isArray(arr) ? arr[index] || "" : inputs[index] || ""
    );
    setFeedback(
      answered[index] ? "✅ Correct! Press C to continue." : ""
    );
    setShowReviewPrompt(false);
    setAddedToReview(false);
    setShowRemovePrompt(false);
    setRemovedFromReview(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Track furthest index we've ever reached (for "back in stack" detection)
  useEffect(() => {
    setFurthestIndex((prev) => (index > prev ? index : prev));
  }, [index]);

       // --- Unanswered question helpers (frontier-based behavior) ---
  function collectUnansweredIndices(arr) {
    const res = [];
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i]) res.push(i);
    }
    return res;
  }

  const unansweredIndices = collectUnansweredIndices(attempted);
  const hasUnanswered = unansweredIndices.length > 0;
  const frontier = hasUnanswered ? unansweredIndices[0] : -1; // first unanswered

  const showGoToUnanswered = (() => {
    // No unanswered = nothing to jump to
    if (frontier === -1) return false;

    // 1) If we're *on* the frontier question, this IS the normal flow spot.
    //    "Next" (or answering it) is how you progress. No jump button.
    if (index === frontier) return false;

    // 2) If all questions up through current index are attempted,
    //    and the frontier is EXACTLY the next question,
    //    then we're still in normal forward flow:
    //    - fresh quiz: answered Q1, frontier=Q2, at index=0
    //    - or after fixing a frontier and its next is the new frontier
    //    In both cases, "Next" walks directly into the right place.
    let allUpToIndexAttempted = true;
    for (let i = 0; i <= index; i++) {
      if (!attempted[i]) {
        allUpToIndexAttempted = false;
        break;
      }
    }
    if (allUpToIndexAttempted && frontier === index + 1) {
      return false;
    }

    const visitedFrontier = furthestIndex >= frontier;

    // 3) If we're PAST the frontier while it's still unanswered,
    //    there's a hole behind us -> show the jump.
    //    Example: X X X _ X X [you here] -> frontier is the _, jump back.
    if (index > frontier) {
      return true;
    }

    // 4) If we've already reached/passed the frontier at some point,
    //    and are now sitting BEFORE it, we left the normal spot -> show jump.
    //    Example: answered up to 4, frontier=5, you once were at 5/6,
    //    now you're back on 2 -> let them jump to 5.
    if (index < frontier && visitedFrontier) {
      return true;
    }

    // 5) Otherwise we're in clean forward flow:
    //    - haven't reached the frontier yet,
    //    - or we're just naturally approaching it.
    //    No jump button.
    return false;
  })();

  function jumpToUnanswered() {
    if (frontier === -1) return;
    setIndex(frontier);
    requestAnimationFrame(() => areaRef.current?.focus());
  }

  // After a correct answer, continue in simple forward order.
  // We no longer try to "bounce back"; the Go To button always
  // takes you to the current frontier explicitly.
  function continueIfCorrect() {
    if (!canContinue) return;
    setFeedback("");
    setIndex((i) => Math.min(i + 1, total - 1));
    areaRef.current?.blur();
  }
  
  function handleChange(val) {
    setInput(val);
    setInputs((arr) => {
      const next = arr.slice();
      next[index] = val;
      return next;
    });
  }

  // Save latest per-quiz score (rounded for display)
  async function saveLatestScore(pctRounded, { review = false } = {}) {
    if (isSyntheticMode) return;
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
        last_score: review
          ? existing?.last_score ?? null
          : pctRounded,
        last_review_score: review
          ? pctRounded
          : existing?.last_review_score ?? null,
      };

      await supabase
        .from("quiz_scores")
        .upsert(payload, { onConflict: "user_id,quiz_id" });
    } catch {
      /* ignore */
    }
  }

  async function maybeFinish(attemptedNext, firstTryNext) {
    if (!attemptedNext.every(Boolean)) return;

    const points = firstTryNext.filter(Boolean).length;
    const pctExact = total ? (points / total) * 100 : 0;
    const pctRounded = Math.round(pctExact);

    setScorePct(pctRounded);
    setShowResult(true);

    await saveLatestScore(pctRounded, { review: isReviewMode });

    if (isSyntheticMode && isReviewMode) {
      if (isGroupMode) {
        const gid = normalizedGroupIdRef.current;
        if (gid) {
          await saveGroupRevisitScore(user?.id, {
            scope: "group",
            groupId: gid,
            percentExact: pctExact,
          });
        }
      } else if (isAllMode) {
        await saveGroupRevisitScore(user?.id, {
          scope: "all",
          groupId: ALL_GROUP_ID,
          percentExact: pctExact,
        });
      }
    }

    if (!isReviewMode && isSyntheticMode) {
      if (isGroupMode) {
        const gid = normalizedGroupIdRef.current;
        if (gid) {
          await saveGroupAllScore(user?.id, {
            scope: "group",
            groupId: gid,
            percentExact: pctExact,
          });
        }
      } else if (isAllMode) {
        await saveGroupAllScore(user?.id, {
          scope: "all",
          groupId: ALL_GROUP_ID,
          percentExact: pctExact,
        });
      }
    }
  }

  async function submitQuizNow() {
    const points = firstTryCorrect.filter(Boolean).length;
    const pctExact = total ? (points / total) * 100 : 0;
    const pctRounded = Math.round(pctExact);

    setScorePct(pctRounded);
    setShowResult(true);

    await saveLatestScore(pctRounded, { review: isReviewMode });

    if (isSyntheticMode && isReviewMode) {
      if (isGroupMode) {
        const gid = normalizedGroupIdRef.current;
        if (gid) {
          await saveGroupRevisitScore(user?.id, {
            scope: "group",
            groupId: gid,
            percentExact: pctExact,
          });
        }
      } else if (isAllMode) {
        await saveGroupRevisitScore(user?.id, {
          scope: "all",
          groupId: ALL_GROUP_ID,
          percentExact: pctExact,
        });
      }
    }

    if (!isReviewMode && isSyntheticMode) {
      if (isGroupMode) {
        const gid = normalizedGroupIdRef.current;
        if (gid) {
          await saveGroupAllScore(user?.id, {
            scope: "group",
            groupId: gid,
            percentExact: pctExact,
          });
        }
      } else if (isAllMode) {
        await saveGroupAllScore(user?.id, {
          scope: "all",
          groupId: ALL_GROUP_ID,
          percentExact: pctExact,
        });
      }
    }
  }

  // --- review helpers (add/remove) ---
  function alreadyInReview(prompt) {
    if (isSyntheticMode && isReviewMode) return true;
    const rv = quiz?.review_questions ?? [];
    const key = (prompt || "").trim().toLowerCase();
    return rv.some(
      (q) => (q?.prompt || "").trim().toLowerCase() === key
    );
  }

  async function addCurrentToReview() {
    if (!current || isSyntheticMode) return;
    if (alreadyInReview(current.prompt)) {
      setAddedToReview(true);
      setShowReviewPrompt(false);
      return;
    }
    const rv = quiz?.review_questions ?? [];
    const newArr = [
      ...rv,
      {
        prompt: String(current.prompt ?? ""),
        answer: String(current.answer ?? ""),
      },
    ];
    const { error } = await supabase
      .from("quizzes")
      .update({
        review_questions: newArr,
        updated_at: new Date().toISOString(),
      })
      .eq("id", quizId)
      .eq("user_id", user.id);

    if (!error) {
      setQuiz((prev) =>
        prev ? { ...prev, review_questions: newArr } : prev
      );
      setAddedToReview(true);
      setShowReviewPrompt(false);
    }
  }

  function addCurrentFromReview() {
    return addCurrentToReview();
  }

  async function removeCurrentFromReview() {
    if (!current) return;

    if (isSyntheticMode) {
      const srcId = current.__srcQuizId;
      const key = (current.prompt || "").trim().toLowerCase();

      const { data: src, error: readErr } = await supabase
        .from("quizzes")
        .select("review_questions, title")
        .eq("id", srcId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (readErr) return;

      const srcRv = Array.isArray(src?.review_questions)
        ? src.review_questions
        : [];
      const pruned = srcRv.filter(
        (q) =>
          (q?.prompt || "").trim().toLowerCase() !== key
      );

      const { error: updErr } = await supabase
        .from("quizzes")
        .update({
          review_questions: pruned,
          updated_at: new Date().toISOString(),
        })
        .eq("id", srcId)
        .eq("user_id", user.id);
      if (updErr) return;

      setQuiz((prev) => {
        if (!prev) return prev;
        const list = Array.isArray(prev.review_questions)
          ? prev.review_questions.slice()
          : [];
        const removedIdx = index;
        if (removedIdx >= 0 && removedIdx < list.length)
          list.splice(removedIdx, 1);
        return { ...prev, review_questions: list };
      });

      const removedIdx = index;
      setRemovedFromReview(true);
      setShowRemovePrompt(false);

      const shrink = (arr) => {
        const next = arr.slice();
        if (removedIdx >= 0 && removedIdx < next.length)
          next.splice(removedIdx, 1);
        return next;
      };

      setAnswered(shrink);
      setInputs(shrink);
      setAttempted(shrink);
      setFirstTryCorrect(shrink);
      setPeekOn(shrink);
      setPeekStash(shrink);

      setIndex((prev) => {
        const newLen = questionsArr.length - 1;
        if (newLen <= 0) return 0;
        const candidate = Math.min(removedIdx, newLen - 1);
        return candidate < 0 ? 0 : candidate;
      });

      return;
    }

    // Normal (single-quiz) review removal
    const rv = quiz?.review_questions ?? [];
    const key = (current.prompt || "").trim().toLowerCase();
    const newArr = rv.filter(
      (q) =>
        (q?.prompt || "").trim().toLowerCase() !== key
    );

    const { error } = await supabase
      .from("quizzes")
      .update({
        review_questions: newArr,
        updated_at: new Date().toISOString(),
      })
      .eq("id", quizId)
      .eq("user_id", user.id);

    if (!error) {
      setQuiz((prev) =>
        prev ? { ...prev, review_questions: newArr } : prev
      );
      setRemovedFromReview(true);
      setShowRemovePrompt(false);

      const removedIdx = index;
      const shrink = (arr) => {
        const next = arr.slice();
        if (removedIdx >= 0 && removedIdx < next.length)
          next.splice(removedIdx, 1);
        return next;
      };

      setAnswered(shrink);
      setInputs(shrink);
      setAttempted(shrink);
      setFirstTryCorrect(shrink);
      setPeekOn(shrink);
      setPeekStash(shrink);

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

    const treatAsStrict = strict; // <-- ONLY the toggle controls strictness now

  if (treatAsStrict) {
    isCorrect = strictFactCorrect(userAns, expected);
    if (!isCorrect) {
      setFeedback(
        "Incorrect ❌ (exact value needed) Press c to continue"
      );
    }
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

      if (isReviewMode && alreadyInReview(current.prompt)) {
        setShowRemovePrompt(true);
        setRemovedFromReview(false);
      } else {
        setShowRemovePrompt(false);
        setRemovedFromReview(false);
      }
    } else {
      const canOfferAdd =
        !isSyntheticMode &&
        !isReviewMode &&
        !alreadyInReview(current.prompt);
      setShowReviewPrompt(canOfferAdd);
      setAddedToReview(false);
      setShowRemovePrompt(false);
      setRemovedFromReview(false);

      if (!treatAsStrict && !/Press c to continue/i.test(feedback)) {
        setFeedback("Incorrect ❌ Press c to continue");
      }
      // if treatAsStrict, the strict block above already set the exact-value message
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

    if (!isC || !canContinue) return;
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

  function retake() {
    const len = questionsArr.length;
    setAnswered(Array(len).fill(false));
    setInputs(Array(len).fill(""));
    setAttempted(Array(len).fill(false));
    setFirstTryCorrect(Array(len).fill(false));
    setIndex(0);
    setFurthestIndex(0);
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
    } else {
      const original = peekStash[index] ?? "";
      handleChange(original);
      setPeekOn((arr) => {
        const next = arr.slice();
        next[index] = false;
        return next;
      });
    }
  }

  // --- UI helpers / styles ---
  const pressAnim =
    "transition-all duration-150 active:scale-[0.97]";
  const btnBase =
    "px-4 py-2 rounded-2xl font-semibold text-sm sm:text-base disabled:opacity-50 disabled:cursor-not-allowed";
  const btnGray = `bg-white/10 hover:bg-white/20 text-white ${pressAnim}`;
  const btnIndigo = `bg-sky-500/90 hover:bg-sky-400 text-slate-950 ${pressAnim}`;

  if (!quiz) return null;

  const originalQuizLink = isSyntheticMode
    ? current?.__srcQuizId
      ? `/play/${current.__srcQuizId}`
      : "#"
    : `/play/${quizId}`;

  const originalQuizDisabled = isSyntheticMode
    ? !current?.__srcQuizId
    : false;

  const experienceLabel = isReviewMode ? "Revisit" : "Play";

  return (
    <div
      className="quiz-play min-h-screen text-slate-100 pb-16"
      onKeyDown={onKey}
      tabIndex={0}
    >
      <header className="sticky top-0 z-30 border-b border-white/5 bg-slate-950/80 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <img
              src="/smartquizlogo.png"
              alt="Smart-Quiz logo"
              className="h-9 sm:h-10 w-auto -ml-2 object-contain drop-shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
              draggable="false"
            />
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-[0.2em] text-white/60">
                {experienceLabel}
              </p>
              <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">
                {quiz.title || "Quiz"}
                {isSyntheticMode
                  ? isReviewMode
                    ? " — Review"
                    : " — All Questions"
                  : isReviewMode
                  ? " — Review"
                  : ""}
              </h1>
            </div>
          </div>
          <Link
            to={backPath}
            className={`${btnBase} ${btnGray} self-start sm:self-auto`}
            title="Go back to dashboard"
          >
            Back
          </Link>
        </div>
      </header>

      <main className="px-4 sm:px-6 py-8 flex justify-center">
        <div className="w-full max-w-[900px]">
          {current ? (
            <>
              <div className="surface-card p-5 sm:p-8 space-y-6">
                  <p className="text-xs uppercase tracking-wide text-white/60">
                    Question {index + 1} / {questionsArr.length}
                  </p>
                <p className="text-lg sm:text-2xl font-semibold leading-snug">
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
                        onChange={(e) =>
                          setStrict(e.target.checked)
                        }
                      />
                      <span className="text-white/70">
                        Strict mode
                      </span>
                    </label>

                    {/* Desktop actions row */}
                    <div className="hidden sm:flex items-center gap-2">
                      {isSyntheticMode ? (
                        <Link
                          to={originalQuizLink}
                          onClick={(e) => {
                            if (originalQuizDisabled)
                              e.preventDefault();
                          }}
                          className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray} ${
                            originalQuizDisabled
                              ? "opacity-50 cursor-not-allowed"
                              : ""
                          }`}
                          title="Go to the original quiz for this question"
                        >
                          Play Main Quiz
                        </Link>
                      ) : isReviewMode ? (
                        <Link
                          to={`/play/${quizId}`}
                          className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray}`}
                          title="Go to the main quiz (not the revisit set)"
                        >
                          Play Main Quiz
                        </Link>
                      ) : (
                        <Link
                          to={`/play/${quizId}?mode=review`}
                          className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray}`}
                          title="Practice only the questions in your review group"
                        >
                          Play Revisit Quiz
                        </Link>
                      )}

                      {!isSyntheticMode && (
                        <>
                          {isReviewMode ? (
                            <button
                              type="button"
                              className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray}`}
                              onClick={removeCurrentFromReview}
                              disabled={
                                !current ||
                                !alreadyInReview(
                                  current?.prompt
                                )
                              }
                            >
                              Remove from Review Group
                            </button>
                          ) : (
                            <button
                              type="button"
                              className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray}`}
                              onClick={addCurrentFromReview}
                              disabled
                              title="(Hidden) Legacy button"
                              style={{ display: "none" }}
                            />
                          )}
                          {!isReviewMode && (
                            <button
                              type="button"
                              className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray}`}
                              onClick={addCurrentToReview}
                              disabled={
                                !current ||
                                alreadyInReview(
                                  current?.prompt
                                )
                              }
                            >
                              Add To Review Group
                            </button>
                          )}
                        </>
                      )}

                      {isSyntheticMode && isReviewMode && (
                        <button
                          type="button"
                          className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray}`}
                          onClick={removeCurrentFromReview}
                          disabled={!current}
                        >
                          Remove from Review Group
                        </button>
                      )}

                      <button
                        type="button"
                        className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray}`}
                        onClick={toggleDisplayAnswer}
                        title={
                          isPeeking
                            ? "Show your original answer"
                            : "Show the correct answer"
                        }
                      >
                        {isPeeking
                          ? "Display My Answer"
                          : "Display answer"}
                      </button>
                    </div>
                  </div>

                  {/* Mobile-only actions */}
                  <div className="mt-2 grid grid-cols-3 gap-2 sm:hidden">
                    {isSyntheticMode ? (
                      <Link
                        to={originalQuizLink}
                        onClick={(e) => {
                          if (originalQuizDisabled)
                            e.preventDefault();
                        }}
                        className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray} min-h-14 py-3 whitespace-normal leading-normal ${
                          originalQuizDisabled
                            ? "opacity-50 cursor-not-allowed"
                            : ""
                        }`}
                      >
                        Play Main Quiz
                      </Link>
                    ) : isReviewMode ? (
                      <Link
                        to={`/play/${quizId}`}
                        className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray} min-h-14 py-3 whitespace-normal leading-normal`}
                      >
                        Play Main Quiz
                      </Link>
                    ) : (
                      <Link
                        to={`/play/${quizId}?mode=review`}
                        className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray} min-h-14 py-3 whitespace-normal leading-normal`}
                      >
                        Play Revisit Quiz
                      </Link>
                    )}

                    {!isSyntheticMode ? (
                      isReviewMode ? (
                        <button
                          type="button"
                          className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray} min-h-14 py-3 whitespace-normal leading-normal`}
                          onClick={removeCurrentFromReview}
                          disabled={
                            !current ||
                            !alreadyInReview(
                              current?.prompt
                            )
                          }
                        >
                          Remove from Review Group
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray} min-h-14 py-3 whitespace-normal leading-normal`}
                          onClick={addCurrentToReview}
                          disabled={
                            !current ||
                            alreadyInReview(
                              current?.prompt
                            )
                          }
                        >
                          Add To Review Group
                        </button>
                      )
                    ) : isReviewMode ? (
                      <button
                        type="button"
                        className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray} min-h-14 py-3 whitespace-normal leading-normal`}
                        onClick={removeCurrentFromReview}
                        disabled={!current}
                      >
                        Remove from Review Group
                      </button>
                    ) : (
                      <div className="min-h-14" />
                    )}

                    <button
                      type="button"
                      className={`inline-flex items-center justify-center text-center ${btnBase} ${btnGray} min-h-14 py-3 whitespace-normal leading-normal`}
                      onClick={toggleDisplayAnswer}
                      title={
                        isPeeking
                          ? "Show your original answer"
                          : "Show the correct answer"
                      }
                    >
                      {isPeeking
                        ? "Display My Answer"
                        : "Display answer"}
                    </button>
                  </div>
                </div>

                {/* TEXTAREA FRAME */}
                <div className="mb-3 lg:flex lg:items-center lg:gap-6">
                  <form onSubmit={submit} className="lg:flex-1">
                    <textarea
                      ref={areaRef}
                      className="w-full h-56 p-4 rounded-lg bg-white text-gray-900 border border-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-600 text-base sm:text-xl placeholder:text-gray-500"
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

                {/* NAV BUTTONS */}
                <div className="mt-0">
                  <div
                    className={`hidden sm:grid ${
                      showGoToUnanswered
                        ? "sm:grid-cols-3"
                        : "sm:grid-cols-2"
                    } gap-3`}
                  >
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
                        onClick={jumpToUnanswered}
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
                      className={`mt-3 text-base sm:text-lg text-center ${
                        isPositiveFeedback
                          ? "text-green-400"
                          : "text-red-400"
                      }`}
                      aria-live="polite"
                    >
                      {feedback}
                    </p>
                  )}

                  {showReviewPrompt && !addedToReview && (
                    <p className="mt-2 text-white text-center text-base sm:text-lg">
                      Add question to review group? Press{" "}
                      <span className="font-semibold">Y</span> for yes.
                    </p>
                  )}
                  {!showReviewPrompt && addedToReview && (
                    <p className="mt-2 text-white text-center text-base sm:text-lg">
                      Added to review group!
                    </p>
                  )}

                  {isReviewMode &&
                    showRemovePrompt &&
                    !removedFromReview && (
                      <p className="mt-2 text-white text-center text-base sm:text-lg">
                        Remove question from review group? Press{" "}
                        <span className="font-semibold">Y</span> for yes.
                      </p>
                    )}
                  {isReviewMode &&
                    !showRemovePrompt &&
                    removedFromReview && (
                      <p className="mt-2 text-white text-center text-base sm:text-lg">
                        Removed question from review group.
                      </p>
                    )}
                </div>
              </div>
            </>
          ) : (
            <div className="surface-card p-5 sm:p-8 text-center space-y-4">
              <p className="text-white/70">
                No questions yet. Add some in the editor.
              </p>
              {(isReviewMode || isSyntheticMode) && (
                <div className="flex justify-center">
                  {isSyntheticMode ? (
                    <Link
                      to="/"
                      className={`${btnBase} ${btnIndigo}`}
                      title="Return to dashboard"
                    >
                      Return to Dashboard
                    </Link>
                  ) : (
                    <Link
                      to={`/play/${quizId}`}
                      className={`${btnBase} ${btnIndigo}`}
                      title="Return to the main quiz"
                    >
                      Return to Main Quiz
                    </Link>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Results Modal */}
      {showResult && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-3 sm:p-4 z-50">
          <div className="surface-card p-5 sm:p-6 max-w-md w-full max-h-[85vh] overflow-y-auto">
            <h2 className="text-xl sm:text-2xl font-bold mb-2">
              {isSyntheticMode
                ? isReviewMode
                  ? "Revisit Score"
                  : "All Questions Score"
                : isReviewMode
                ? "Revisit Score"
                : "Your Score"}{" "}
              {hasConfetti ? "🎉" : ""}
            </h2>
            <p className="text-base sm:text-lg mb-6">
              You scored{" "}
              <span className="font-semibold">{scorePct}%</span> on this{" "}
              {isSyntheticMode
                ? isReviewMode
                  ? "revisit set"
                  : "all-questions set"
                : isReviewMode
                ? "revisit set"
                : "quiz"}
              .
            </p>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2">
              <button
                type="button"
                className={`${btnBase} ${btnGray} w-full sm:w-auto`}
                onClick={retake}
              >
                Retake
              </button>
              <button
                type="button"
                className={`${btnBase} ${btnIndigo} w-full sm:w-auto`}
                onClick={() => navigate(backPath)}
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
