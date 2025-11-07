// src/pages/Dashboard.jsx
import { Play, History, SquarePen, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";

import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/build/pdf.mjs";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { getInitialGroupFromUrlOrStorage, persistLastGroup } from "../lib/groupFilter";
import { useLocation } from "react-router-dom";

/* ------------------------------- CONSTANTS -------------------------------- */
const ALL_GROUP_ID = "00000000-0000-0000-0000-000000000000"; // sentinel for “All”
const NO_GROUP = "__none__";
const NO_GROUP_ID = "00000000-0000-0000-0000-000000000001"; // sentinel for “No Group” in group_scores

// --- DEBUG: expose sentinels & logger in window for devtools ---
if (typeof window !== "undefined") {
  window.__SQ_SENTINELS__ = { ALL_GROUP_ID, NO_GROUP, NO_GROUP_ID };
}
function dbg(...args) {
  // comment this out later
  console.log("[DashDBG]", ...args);
}

/* ------------------------------- HELPERS (DB) ------------------------------ */
async function fetchAllRevisitScore(sb) {
  try {
    const { data: ures } = await sb.auth.getUser();
    const userId = ures?.user?.id;
    if (!userId) return null;

    let { data, error } = await sb
      .from("group_scores")
      .select("last_review_score, updated_at")
      .eq("user_id", userId)
      .eq("scope", "all")
      .eq("group_id", ALL_GROUP_ID)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!error && typeof data?.last_review_score === "number") {
      return data.last_review_score;
    }

    const res2 = await sb
      .from("group_scores")
      .select("last_review_score, updated_at")
      .eq("user_id", userId)
      .eq("scope", "all")
      .is("group_id", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!res2.error && typeof res2.data?.last_review_score === "number") {
      return res2.data.last_review_score;
    }

    return null;
  } catch {
    return null;
  }
}

async function fetchGroupRevisitScoresMap(sb, userId) {
  try {
    const { data, error } = await sb
      .from("group_scores")
      .select("group_id, last_review_score")
      .eq("user_id", userId)
      .eq("scope", "group");

    if (error) return new Map();
    const m = new Map();
    for (const r of data || []) {
      if (r.group_id) m.set(r.group_id, r.last_review_score ?? null);
    }
    return m;
  } catch {
    return new Map();
  }
}

/* --------------------------------- PDF.js --------------------------------- */
GlobalWorkerOptions.workerSrc = workerSrc;

/* ========================================================================== */
/*                                DASHBOARD                                   */
/* ========================================================================== */
export default function Dashboard() {
  const nav = useNavigate();
  const { user, ready, signout, signupOrLink, signin } = useAuth();

const [allRevisitScore, setAllRevisitScore] = useState(null);
const [groupRevisitScores, setGroupRevisitScores] = useState(new Map());

// NEW: All-Questions (non-Revisit) score tracking
const [allAllScore, setAllAllScore] = useState(null);
const [groupAllScores, setGroupAllScores] = useState(new Map());

  async function refreshAllRevisitScore() {
    const v = await fetchAllRevisitScore(supabase);
    setAllRevisitScore(v);
  }
  useEffect(() => {
    const onFocus = () => refreshAllRevisitScore();
    window.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!user?.id) {
        if (alive) setAllRevisitScore(null);
        return;
      }
      const val = await fetchAllRevisitScore(supabase);
      if (alive) setAllRevisitScore(val);
    })();
    return () => {
      alive = false;
    };
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    let alive = true;
    (async () => {
      const m = await fetchGroupRevisitScoresMap(supabase, user.id);
      if (alive) setGroupRevisitScores(m);
    })();
    return () => {
      alive = false;
    };
  }, [user?.id]);

  const pressAnim = "transition-transform duration-100 active:scale-95";
  const btnBase =
    "px-3 py-2 rounded disabled:opacity-60 disabled:cursor-not-allowed";
  const btnGray = `bg-gray-700 hover:bg-gray-600 ${pressAnim}`;
  const btnGreen = `bg-emerald-500 hover:bg-emerald-600 font-semibold ${pressAnim}`;
  const btnRed = `bg-red-600 hover:bg-red-700 ${pressAnim}`;
  const btnRedSoft = `bg-red-500 hover:bg-red-600 ${pressAnim}`;
  const actionH = "min-h-[3rem] h-auto sm:h-12";

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
  const isAnon = computeIsAnon(user);

  useEffect(() => {
    if (!ready) return;
    if (!import.meta.env.DEV) return;
    const snapshot = {
      isAnon,
      email: user?.email ?? null,
      app_provider: user?.app_metadata?.provider ?? null,
      app_providers: user?.app_metadata?.providers ?? null,
      identities: Array.isArray(user?.identities)
        ? user.identities.map((i) => i?.provider)
        : null,
      is_anonymous_top: user?.is_anonymous ?? null,
      is_anonymous_meta: user?.user_metadata?.is_anonymous ?? null,
    };
    console.log("auth snapshot", snapshot);
  }, [ready, user, isAnon]);

  const [quizzes, setQuizzes] = useState([]);
  const [scoresByQuiz, setScoresByQuiz] = useState({});

  const [authOpen, setAuthOpen] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPass, setAuthPass] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState("");

  async function handleCreateAccount() {
    try {
      setAuthBusy(true);
      const email = (authEmail || "").trim();
      const password = authPass || "";
      if (!email || !password) {
        alert("Please enter email and password.");
        return;
      }
      await signupOrLink(email, password);
      setAuthMessage(
        "Check your email to confirm your account, then return here."
      );
    } catch (err) {
      console.error(err);
      alert(err?.message || "Failed to start signup.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signInExisting() {
    try {
      setAuthBusy(true);
      const email = (authEmail || "").trim();
      const password = authPass || "";
      if (!email || !password) {
        alert("Please enter email and password.");
        return;
      }
      const res = await signin(email, password);
      if (res?.error) {
        alert(res.error.message || "Failed to sign in.");
        return;
      }
      setAuthMessage("");
      setAuthOpen(false);
    } catch (err) {
      console.error(err);
      alert("Something went wrong. Please try again.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function continueWithGoogle() {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (error) alert(error.message);
    } catch (e) {
      console.error(e);
      alert("Google sign-in failed. Please try again.");
    }
  }

  async function handleSignOut() {
    await signout();
    setAuthMessage(
      "You’re signed out. Sign in or create an account to save your progress."
    );
    setAuthOpen(true);
  }

  const [trial, setTrial] = useState({
    isAnon: false,
    remaining: Infinity,
    loading: true,
  });
  function openSignupModal(msg) {
    setAuthMessage(
      msg || "Free trial limit reached. Create an account to make more quizzes."
    );
    setAuthOpen(true);
  }

  function openAccountModal() {
    if (!user || isAnon) return;
    setAccountError("");
    setAccountConfirmOpen(false);
    setAccountOpen(true);
  }

    async function performAccountDeletion() {
    if (!user?.id || accountDeleting) return;

    // Immediately hide the confirmation popup so it never hangs around
    setAccountConfirmOpen(false);

    try {
      setAccountDeleting(true);
      setAccountError("");

      // Get current session + access token
      const { data, error: sessionError } = await supabase.auth.getSession();
      const session = data?.session;
      const accessToken = session?.access_token;

      if (sessionError || !accessToken) {
        console.error("No valid session for delete-account", sessionError);
        setAccountError(
          "You need to be signed in to delete your account. Please refresh and try again."
        );
        return;
      }

      // Call delete-account Edge Function
      const { error: fnError } = await supabase.functions.invoke(
        "delete-account",
        {
          body: { accessToken },
        }
      );

      if (fnError) {
        console.error("delete-account function error", fnError);
        setAccountError(
          "Could not delete your account. Please try again, or email support@smart-quiz.app."
        );
        return;
      }

      // Success: sign out, close Account modal, redirect
      await signout();
      setAccountOpen(false);
      window.location.href = "/";
    } catch (err) {
      console.error("Account delete failed:", err);
      setAccountError(
        "Could not delete your account. Please try again, or email support@smart-quiz.app."
      );
    } finally {
      setAccountDeleting(false);
    }
  }


  const [confirmOpen, setConfirmOpen] = useState(false);
  const [target, setTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

   // Account modal + delete-account flow
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountConfirmOpen, setAccountConfirmOpen] = useState(false);
  const [accountDeleting, setAccountDeleting] = useState(false);
  const [accountError, setAccountError] = useState("");

  const [genOpen, setGenOpen] = useState(false);
  const [gTitle, setGTitle] = useState("");
  const [gTopic, setGTopic] = useState("");
  const [gCount, setGCount] = useState(10);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [gGroupId, setGGroupId] = useState("");
  const [gFile, setGFile] = useState(null);
  const [gNoRepeat, setGNoRepeat] = useState(true);

  const [gNewOpen, setGNewOpen] = useState(false);
  const [gNewName, setGNewName] = useState("");
  const [gCreatingGroup, setGCreatingGroup] = useState(false);

   // Animated "Generating..." dots for overlay
  const [genDots, setGenDots] = useState(".");

  const location = useLocation();

const [groups, setGroups] = useState([]);
const [filterGroupId, setFilterGroupId] = useState(() =>
  getInitialGroupFromUrlOrStorage(location.search)
);
  const scoreSort = "asc";
  const currentGroup = groups.find((g) => g.id === filterGroupId) || null;

  dbg("INIT filterGroupId =", JSON.stringify(filterGroupId));

  const [editGroupOpen, setEditGroupOpen] = useState(false);
  const [editGroupName, setEditGroupName] = useState("");
  const [savingGroupName, setSavingGroupName] = useState(false);

  const [cleanupQueue, setCleanupQueue] = useState([]);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupGroup, setCleanupGroup] = useState(null);
  const [cleaning, setCleaning] = useState(false);

  const [selectedIds, setSelectedIds] = useState(new Set());
  const hasSelected = selectedIds.size > 0;

  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveGroupId, setMoveGroupId] = useState("");
  const [moveNewName, setMoveNewName] = useState("");
  const [moving, setMoving] = useState(false);

  const [deleteGroupOpen, setDeleteGroupOpen] = useState(false);
  const [deletingGroup, setDeletingGroup] = useState(false);

  const [query, setQuery] = useState("");

  async function load() {
  let q = supabase
    .from("quizzes")
    .select("id, title, questions, review_questions, updated_at, group_id")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  // Normalize the current selection
  const sel = (filterGroupId ?? "").trim();
  const isAll = sel === "" || sel === ALL_GROUP_ID;   // treat sentinel as All
  const isNoGroup = sel === NO_GROUP || sel === "null";

  if (isNoGroup) {
    q = q.is("group_id", null);
  } else if (!isAll) {
    q = q.eq("group_id", sel);
  }

  const { data, error } = await q;
  if (error) {
    setQuizzes([]);
    setScoresByQuiz({});
    setAllRevisitScore(null);
    setGroupRevisitScores(new Map());
    setAllAllScore(null);
    setGroupAllScores(new Map());
    return;
  }

  const list = data ?? [];
  setQuizzes(list);

  const ids = list.map((x) => x.id);
  if (!ids.length) {
    setScoresByQuiz({});
  } else {
    const { data: scores, error: sErr } = await supabase
      .from("quiz_scores")
      .select("quiz_id, last_score, last_review_score")
      .in("quiz_id", ids)
      .eq("user_id", user.id);

    if (sErr || !scores) {
      setScoresByQuiz({});
    } else {
      const map = {};
      for (const row of scores) {
        map[row.quiz_id] = {
          last: row.last_score ?? null,
          review: row.last_review_score ?? null,
        };
      }
      setScoresByQuiz(map);
    }
  }

  // Read all score rows for this user (ordered newest first)
  const { data: gs, error: gErr } = await supabase
    .from("group_scores")
    .select("scope, group_id, last_review_score, last_all_score, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (gErr || !gs) {
    setAllRevisitScore(null);
    setGroupRevisitScores(new Map());
    setAllAllScore(null);
    setGroupAllScores(new Map());
    return;
  }

  // ---- ALL bucket (allow sentinel or legacy NULL) --------------------------
  const allRow =
    gs.find((r) => r.scope === "all" && r.group_id === ALL_GROUP_ID) ??
    gs.find((r) => r.scope === "all" && r.group_id == null);

  setAllRevisitScore(
    typeof allRow?.last_review_score === "number" ? allRow.last_review_score : null
  );
  setAllAllScore(
    typeof allRow?.last_all_score === "number" ? allRow.last_all_score : null
  );

  // ---- GROUP buckets -------------------------------------------------------
  const mReview = new Map();
  const mAll = new Map();

  for (const r of gs) {
    if (r.scope !== "group") continue;

    const gid = r.group_id == null ? NO_GROUP_ID : r.group_id;

    if (!mReview.has(gid) && typeof r.last_review_score === "number") {
      mReview.set(gid, r.last_review_score);
    }
    if (!mAll.has(gid) && typeof r.last_all_score === "number") {
      mAll.set(gid, r.last_all_score);
    }
  }

  setGroupRevisitScores(mReview);
  setGroupAllScores(mAll);
}

useEffect(() => {
    if (!generating) {
      setGenDots(".");
      return;
    }
    const id = setInterval(() => {
      setGenDots((prev) => (prev.length >= 3 ? "." : prev + "."));
    }, 400);
    return () => clearInterval(id);
  }, [generating]);


// Load dashboard aggregates (groups, scores, etc.)
useEffect(() => {
  if (ready && user) load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [ready, user?.id, filterGroupId]);

// Persist the current group filter so Play → Dashboard restores it
useEffect(() => {
  persistLastGroup(filterGroupId || "");
  console.log("[Dash] persistLastGroup ->", filterGroupId || "");
}, [filterGroupId]);

// Normalize ALL_GROUP_ID to "" so "All" footer/actions always render
useEffect(() => {
  const v = getInitialGroupFromUrlOrStorage(location.search);
  let normalized = v == null ? "" : v;
  if (normalized === ALL_GROUP_ID) normalized = ""; // ← key fix
  dbg("URL sync fired:", { search: location.search, v, normalized });
  setFilterGroupId((prev) => {
    const next = prev === normalized ? prev : normalized;
    if (prev !== next) dbg("filterGroupId changed via URL sync:", { prev, next });
    return next;
  });
}, [location.search]);

// Fetch groups (for dropdown)
useEffect(() => {
  if (!user?.id) return;
  let alive = true;
  (async () => {
    const { data, error } = await supabase
      .from("groups")
      .select("id, name")
      .eq("user_id", user.id)
      .order("name", { ascending: true });

    if (!alive) return;
    if (error) {
      console.error("[Dash] groups read error", error);
      setGroups([]);
      return;
    }
    setGroups(data ?? []);
  })();
  return () => {
    alive = false;
  };
}, [user?.id]);

// 🔎 FETCH QUIZZES (diagnostic: ensure 'All' selection doesn't filter; log state)
useEffect(() => {
  if (!user?.id) return;

  // safe logger (uses dbg() if you added it; otherwise falls back to console.log)
  const _dbg = (...a) => {
    try {
      (typeof dbg === "function" ? dbg : console.log)("[DashDBG]", ...a);
    } catch {}
  };

  // Normalize the selection
  const sel = (filterGroupId ?? "").trim();
  const isAll = sel === "" || sel === ALL_GROUP_ID; // "" = All
  const isNoGroup = sel === NO_GROUP || sel === "null"; // do NOT treat "" as No group

  let alive = true;

  (async () => {
    _dbg("FETCH start", { raw: filterGroupId, sel, isAll, isNoGroup, userId: user?.id });

    let q = supabase
      .from("quizzes")
      .select("id, title, group_id, questions, review_questions, updated_at")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false });

    // ✅ Do NOT add a group filter when “All” is selected
    if (isNoGroup) {
      q = q.is("group_id", null);
    } else if (!isAll) {
      q = q.eq("group_id", sel);
    }

    const { data, error } = await q;

    if (!alive) return;

    if (error) {
      _dbg("FETCH error", error);
      setQuizzes([]);
      return;
    }

    _dbg("FETCH done", { count: (data || []).length, isAll, isNoGroup });
    setQuizzes(data || []);
  })();

  return () => {
    alive = false;
  };
}, [user?.id, filterGroupId]);
// Anonymous trial counters
useEffect(() => {
  if (!user?.id) return;
  (async () => {
    const anon =
      !!user &&
      Array.isArray(user.identities) &&
      user.identities.some((i) => i?.provider === "anonymous");
    if (!anon) {
      setTrial({ isAnon: false, remaining: Infinity, loading: false });
      return;
    }
    const { count } = await supabase
      .from("quizzes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);
    setTrial({
      isAnon: true,
      remaining: Math.max(0, 2 - (count ?? 0)),
      loading: false,
    });
  })();
}, [user?.id, quizzes.length]);

function toggleSelected(quizId) {
  setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(quizId)) next.delete(quizId);
    else next.add(quizId);
    return next;
  });
}
function clearSelection() {
  setSelectedIds(new Set());
}

function enqueueEmptyGroups(ids) {
  if (!ids?.length) return;
  setCleanupQueue((prev) => {
    const set = new Set(prev);
    ids.forEach((id) => id && set.add(id));
    return Array.from(set);
  });
}

  async function checkEmptyGroup(groupId) {
    if (!groupId) return null;
    const { count, error } = await supabase
      .from("quizzes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("group_id", groupId);
    if (error) return null;
    if ((count ?? 0) > 0) return null;
    const { data: g, error: gErr } = await supabase
      .from("groups")
      .select("id, name")
      .eq("id", groupId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (gErr || !g?.id) return null;
    return g;
  }
  async function runNextCleanupIfIdle() {
    if (cleanupOpen) return;
    const nextId = cleanupQueue[0] ?? null;
    if (!nextId) return;
    const g = await checkEmptyGroup(nextId);
    if (g) {
      setCleanupGroup({ id: g.id, name: g.name });
      setCleanupOpen(true);
    } else {
      setCleanupQueue((q) => q.slice(1));
    }
  }
  useEffect(() => {
    if (!cleanupOpen) setTimeout(runNextCleanupIfIdle, 0);
  }, [cleanupQueue.length, cleanupOpen]);

  function keepEmptyGroupNow() {
    setCleanupOpen(false);
    setCleanupGroup(null);
    setCleanupQueue((q) => q.slice(1));
  }
  async function deleteEmptyGroupNow() {
    if (!cleanupGroup?.id) return;
    try {
      setCleaning(true);
      const { error } = await supabase
        .from("groups")
        .delete()
        .eq("id", cleanupGroup.id)
        .eq("user_id", user.id);
      if (!error) {
        setGroups((gs) => gs.filter((g) => g.id !== cleanupGroup.id));
        setFilterGroupId((cur) => (cur === cleanupGroup.id ? "" : cur));
      } else {
        alert("Failed to delete group. Please try again.");
      }
    } finally {
      setCleaning(false);
      setCleanupOpen(false);
      setCleanupGroup(null);
      setCleanupQueue((q) => q.slice(1));
    }
  }

  async function createQuiz() {
    if (creating) return;
    try {
      const allowed = await ensureCanCreate();
      if (!allowed) return;
      setCreating(true);
      const { data, error } = await supabase
        .from("quizzes")
        .insert({ user_id: user.id, title: "Untitled Quiz", questions: [] })
        .select("id")
        .single();
      if (error) {
        if (error.code === "42501") {
          openSignupModal(
            "Free trial limit reached. Create an account to make more quizzes."
          );
          return;
        }
        alert(error.message || "Failed to create quiz.");
        return;
      }
      nav(`/edit/${data.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete() {
    if (!target) return;
    setDeleting(true);
    const thisGroupId = target.group_id ?? null;
    const thisId = target.id;
    const { error } = await supabase
      .from("quizzes")
      .delete()
      .eq("id", thisId)
      .eq("user_id", user.id);
    setDeleting(false);
    if (!error) {
      setQuizzes((qs) => qs.filter((x) => x.id !== thisId));
      setConfirmOpen(false);
      setTarget(null);
      setSelectedIds((prev) => {
        if (!prev.has(thisId)) return prev;
        const next = new Set(prev);
        next.delete(thisId);
        return next;
      });
      if (thisGroupId) enqueueEmptyGroups([thisGroupId]);
    } else {
      alert("Failed to delete. Please try again.");
    }
  }

  async function extractTextFromFile(file) {
    if (
      file.type?.startsWith("text/") ||
      file.name.toLowerCase().endsWith(".txt") ||
      file.name.toLowerCase().endsWith(".md")
    ) {
      return await file.text();
    }
    if (
      file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf")
    ) {
      const buf = await file.arrayBuffer();
      const pdf = await getDocument({ data: buf }).promise;
      let out = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        out += content.items.map((it) => it.str).join(" ") + "\n";
      }
      return out;
    }
    return await file.text();
  }

  async function ensureCanCreate() {
    const { data: ures } = await supabase.auth.getUser();
    const anon =
      !!ures?.user &&
      Array.isArray(ures.user.identities) &&
      ures.user.identities.some((i) => i?.provider === "anonymous");
    if (!anon) return true;
    const { count } = await supabase
      .from("quizzes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ures.user.id);
    if ((count ?? 0) >= 2) {
      openSignupModal(
        "Free trial limit reached. Create an account to make more quizzes."
      );
      return false;
    }
    return true;
  }

  async function generateQuiz() {
    try {
      if (generating) return;
      const allowed = await ensureCanCreate();
      if (!allowed) return;
      setGenerating(true);

      const { data: sessionRes } = await supabase.auth.getSession();
      const jwt = sessionRes?.session?.access_token;
      const count = Math.max(1, Math.min(Number(gCount) || 10, 30));

      const targetGroupIdForNoRepeat =
        (gGroupId && gGroupId !== "") ||
        (filterGroupId && filterGroupId !== NO_GROUP)
          ? gGroupId || (filterGroupId !== NO_GROUP ? filterGroupId : "")
          : "";

      let file_id = null;
      if (gFile) {
        let rawDoc = "";
        try {
          rawDoc = await extractTextFromFile(gFile);
        } catch (e) {
          alert(`Couldn't read file "${gFile.name}".\n\n${e}`);
          setGenerating(false);
          return;
        }
        const LIMIT = 500_000;
        if (rawDoc.length > LIMIT) rawDoc = rawDoc.slice(0, LIMIT);

        const idxRes = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/index-source`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
            },
            body: JSON.stringify({ text: rawDoc, file_name: gFile.name }),
          }
        );
        const idxText = await idxRes.text();
        if (!idxRes.ok) {
          alert(`Failed to index document (${idxRes.status}):\n${idxText}`);
          setGenerating(false);
          return;
        }
        let idxOut = {};
        try {
          idxOut = idxText ? JSON.parse(idxText) : {};
        } catch {}
        file_id = idxOut?.file_id ?? null;
        if (!file_id) {
          alert("Indexing returned no file_id.");
          setGenerating(false);
          return;
        }
      }

      let avoid_prompts = [];
      if (gNoRepeat && targetGroupIdForNoRepeat) {
        const { data: prior, error: priorErr } = await supabase
          .from("quizzes")
          .select("questions")
          .eq("user_id", user.id)
          .eq("group_id", targetGroupIdForNoRepeat);
        if (!priorErr && Array.isArray(prior)) {
          const all = [];
          for (const row of prior) {
            const qs = Array.isArray(row?.questions) ? row.questions : [];
            for (const q of qs) {
              const p = (q?.prompt || "").toString().trim();
              if (p) all.push(p);
            }
          }
          const seen = new Set();
          for (const p of all) {
            const key = p.toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              avoid_prompts.push(p);
            }
            if (avoid_prompts.length >= 300) break;
          }
        }
      }

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-quiz`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
          },
          body: JSON.stringify({
            title: (gTitle || "").trim() || "Bash Top 10",
            topic:
              (gTopic || "").trim() ||
              "Create 10 questions that test the 10 most-used Bash commands.",
            count,
            group_id: gGroupId || null,
            file_id,
            no_repeat: !!gNoRepeat,
            avoid_prompts,
          }),
        }
      );

      let raw = "";
      try {
        raw = await res.text();
      } catch {}

      if (!res.ok) {
        if (res.status === 403)
          openSignupModal(
            "Free trial limit reached. Create an account to make more quizzes."
          );
        else
          alert(
            `Failed to generate quiz (${res.status}):\n${raw || "Unknown error"}`
          );
        setGenerating(false);
        return;
      }

      setGenOpen(false);
      if (gFile) setGFile(null);
      setGenerating(false);
      await load();
    } catch (e) {
      console.error(e);
      alert("Failed to generate quiz. Please try again.");
      setGenerating(false);
    }
  }

  async function createGroupForModal() {
    if (!gNewName.trim() || gCreatingGroup) return;
    try {
      setGCreatingGroup(true);
      const { data, error } = await supabase
        .from("groups")
        .insert({ user_id: user.id, name: gNewName.trim() })
        .select("id, name")
        .single();
      if (!error && data) {
        setGroups((gs) =>
          [...gs, data].sort((a, b) => a.name.localeCompare(b.name))
        );
        setGGroupId(data.id);
        setGNewOpen(false);
        setGNewName("");
      } else {
        alert("Failed to create group. Please try again.");
      }
    } finally {
      setGCreatingGroup(false);
    }
  }

  async function doBulkDelete() {
    if (!selectedIds.size) return;
    setBulkDeleting(true);
    try {
      const ids = Array.from(selectedIds);
      const { data: rows, error: readErr } = await supabase
        .from("quizzes")
        .select("id, group_id")
        .in("id", ids)
        .eq("user_id", user.id);
      if (readErr) throw readErr;
      const affectedGroupIds = Array.from(
        new Set((rows || []).map((r) => r.group_id).filter(Boolean))
      );

      const { error } = await supabase
        .from("quizzes")
        .delete()
        .in("id", ids)
        .eq("user_id", user.id);
      if (error) throw error;

      clearSelection();
      setBulkConfirmOpen(false);
      await load();
      if (affectedGroupIds.length) enqueueEmptyGroups(affectedGroupIds);
    } catch {
      alert("Failed to delete selected quizzes. Please try again.");
    } finally {
      setBulkDeleting(false);
    }
  }

  async function doBulkMove() {
    if (!selectedIds.size) return;
    setMoving(true);
    try {
      const ids = Array.from(selectedIds);
      const { data: beforeRows, error: beforeErr } = await supabase
        .from("quizzes")
        .select("id, group_id")
        .in("id", ids)
        .eq("user_id", user.id);
      if (beforeErr) throw beforeErr;
      const prevGroupIds = Array.from(
        new Set((beforeRows || []).map((r) => r.group_id).filter(Boolean))
      );

      let targetGroupId = moveGroupId || "";
      if (moveNewName.trim()) {
        const { data: g, error: gErr } = await supabase
          .from("groups")
          .insert({ user_id: user.id, name: moveNewName.trim() })
          .select("id, name")
          .single();
        if (gErr) throw gErr;
        setGroups((gs) =>
          [...gs, g].sort((a, b) => a.name.localeCompare(b.name))
        );
        targetGroupId = g.id;
      }

      const { error } = await supabase
        .from("quizzes")
        .update({
          group_id: targetGroupId || null,
          updated_at: new Date().toISOString(),
        })
        .in("id", ids)
        .eq("user_id", user.id);
      if (error) throw error;

      setMoveOpen(false);
      setMoveGroupId("");
      setMoveNewName("");
      clearSelection();
      await load();

      const toCheck = prevGroupIds.filter(
        (gid) => gid !== (targetGroupId || null)
      );
      if (toCheck.length) enqueueEmptyGroups(toCheck);
    } catch {
      alert("Failed to move selected quizzes. Please try again.");
    } finally {
      setMoving(false);
    }
  }

  async function deleteCurrentGroupNow() {
    if (!currentGroup?.id) return;
    try {
      setDeletingGroup(true);
      const { error: qErr } = await supabase
        .from("quizzes")
        .delete()
        .eq("user_id", user.id)
        .eq("group_id", currentGroup.id);
      if (qErr) throw qErr;
      const { error: gErr } = await supabase
        .from("groups")
        .delete()
        .eq("user_id", user.id)
        .eq("id", currentGroup.id);
      if (gErr) throw gErr;

      setDeleteGroupOpen(false);
      setDeletingGroup(false);
      setFilterGroupId("");
      await load();
      setGroups((gs) => gs.filter((g) => g.id !== currentGroup.id));
    } catch (e) {
      console.error(e);
      alert("Failed to delete group. Please try again.");
      setDeletingGroup(false);
    }
  }
  function openEditGroup() {
    if (!currentGroup) return;
    setEditGroupName(currentGroup.name || "");
    setEditGroupOpen(true);
  }
  async function saveGroupName() {
    if (!currentGroup?.id || !editGroupName.trim()) return;
    try {
      setSavingGroupName(true);
      const { data, error } = await supabase
        .from("groups")
        .update({ name: editGroupName.trim() })
        .eq("user_id", user.id)
        .eq("id", currentGroup.id)
        .select("id, name")
        .single();
      if (error) throw error;
      setGroups((gs) =>
        gs
          .map((g) =>
            g.id === currentGroup.id ? { ...g, name: data.name } : g
          )
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      setEditGroupOpen(false);
    } catch (e) {
      console.error(e);
      alert("Failed to rename group. Please try again.");
    } finally {
      setSavingGroupName(false);
    }
  }

  const sortedQuizzes = useMemo(() => {
    return [...quizzes].sort((a, b) => {
      const ad = new Date(a?.updated_at || 0).getTime();
      const bd = new Date(b?.updated_at || 0).getTime();
      return bd - ad;
    });
  }, [quizzes]);

  const visibleQuizzes = useMemo(() => {
    const q = (query || "").toLowerCase();
    if (!q) return sortedQuizzes;
    return sortedQuizzes.filter((x) =>
      (x.title || "").toLowerCase().includes(q)
    );
  }, [sortedQuizzes, query]);

  // Revisit counts (existing)
const groupReviewCount = useMemo(() => {
  if (!(filterGroupId && filterGroupId !== NO_GROUP)) return 0;
  return visibleQuizzes.reduce(
    (sum, q) => sum + (q?.review_questions?.length ?? 0),
    0
  );
}, [visibleQuizzes, filterGroupId]);

const noGroupReviewCount = useMemo(() => {
  if (filterGroupId !== NO_GROUP) return 0;
  return visibleQuizzes.reduce(
    (sum, q) => sum + (q?.review_questions?.length ?? 0),
    0
  );
}, [visibleQuizzes, filterGroupId]);

const allReviewCount = useMemo(() => {
  if (filterGroupId !== "") return 0;
  return visibleQuizzes.reduce(
    (sum, q) => sum + (q?.review_questions?.length ?? 0),
    0
  );
}, [visibleQuizzes, filterGroupId]);

// NEW: All-Questions counts (any question, not just Revisit)
const groupAllCount = useMemo(() => {
  if (!(filterGroupId && filterGroupId !== NO_GROUP)) return 0;
  return visibleQuizzes.reduce((sum, q) => sum + (q?.questions?.length ?? 0), 0);
}, [visibleQuizzes, filterGroupId]);

const noGroupAllCount = useMemo(() => {
  if (filterGroupId !== NO_GROUP) return 0;
  return visibleQuizzes.reduce((sum, q) => sum + (q?.questions?.length ?? 0), 0);
}, [visibleQuizzes, filterGroupId]);

const allAllCount = useMemo(() => {
  if (filterGroupId !== "") return 0;
  return visibleQuizzes.reduce((sum, q) => sum + (q?.questions?.length ?? 0), 0);
}, [visibleQuizzes, filterGroupId]);


useEffect(() => {
  dbg("COUNTS", {
    filterGroupId,
    groupReviewCount,
    noGroupReviewCount,
    allReviewCount,
    groupAllCount,
    noGroupAllCount,
    allAllCount,
    allRevisitScore,
    allAllScore,
    groupRevisitForCurrent: currentGroup ? groupRevisitScores.get(currentGroup.id) : null,
    groupAllForCurrent: currentGroup ? groupAllScores.get(currentGroup.id) : null,
  });
}, [
  filterGroupId,
  groupReviewCount,
  noGroupReviewCount,
  allReviewCount,
  groupAllCount,
  noGroupAllCount,
  allAllCount,
  allRevisitScore,
  allAllScore,
  currentGroup,
  groupRevisitScores,
  groupAllScores,
]);

  const railRef = useRef(null);
  const CARD_W = 520;
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  function updateScrollButtons() {
    const el = railRef.current;
    if (!el) {
      setCanLeft(false);
      setCanRight(false);
      return;
    }
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    const eps = 1;
    setCanLeft(el.scrollLeft > eps);
    setCanRight(max - el.scrollLeft > eps);
  }

  useEffect(() => {
    updateScrollButtons();
    const onResize = () => updateScrollButtons();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    setTimeout(updateScrollButtons, 0);
  }, [visibleQuizzes.length]);

  function scrollLeft() {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: -(rail.clientWidth || CARD_W), behavior: "smooth" });
  }
  function scrollRight() {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: rail.clientWidth || CARD_W, behavior: "smooth" });
  }

  /* ---------------------------------- UI ---------------------------------- */
  return (
    <div className="min-h-screen bg-gray-900 text-white overflow-x-hidden">
      <header className="border-b border-gray-800 px-6 sm:px-8 lg:px-12 py-3 sm:py-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 items-center">
          <h1 className="text-xl font-bold justify-self-start self-center order-2 sm:order-none mt-2 sm:mt-0">
            Your Quizzes
          </h1>
          <div className="flex items-center justify-center col-span-2 sm:col-span-1 order-1 sm:order-none">
            <img
              src="/smartquizlogo.png"
              alt="Smart-Quiz logo"
              className="h-12 sm:h-10 md:h-16 w-auto my-2 sm:my-3 object-contain select-none pointer-events-none"
              draggable="false"
            />
          </div>

          <div className="flex items-center gap-3 text-sm justify-self-end self-center min-w-0 col-span-1 sm:col-span-1 order-2 sm:order-none mt-2 sm:mt-0">
            {!ready ? (
              <span className="text-gray-400">Loading…</span>
            ) : isAnon ? (
              <>
                <span className="text-gray-300 hidden sm:inline">Guest</span>
                <button
                  onClick={() => {
                    setAuthMessage("");
                    setAuthOpen(true);
                  }}
                  className={`${btnBase} ${btnGreen}`}
                >
                  Sign Up / Sign In
                </button>
              </>
            ) : user ? (
              <>
                <span className="text-gray-300 hidden md:inline max-w-[28ch] truncate">
                  {user.email}
                </span>
                <button
                  onClick={openAccountModal}
                  className={`${btnBase} ${btnGray} whitespace-nowrap`}
                >
                  Account
                </button>
                <button
                  onClick={handleSignOut}
                  className={`${btnBase} ${btnGray} whitespace-nowrap`}
                >
                  Sign out
                </button>
              </>
            ) : (
              <button
                onClick={() => {
                  setAuthMessage("");
                  setAuthOpen(true);
                }}
                className={`${btnBase} ${btnGreen}`}
              >
                Sign Up / Sign In
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6">
       {/* ---- MOBILE actions ---- */}
<div className="mb-6 sm:hidden">
  {/* Top buttons (unchanged positions) */}
  <div className="flex items-stretch gap-2">
    <button
      onClick={async () => {
        if (filterGroupId && filterGroupId !== NO_GROUP) setGGroupId(filterGroupId);
        else setGGroupId("");
        const allowed = await ensureCanCreate();
        if (!allowed) return;
        setGenOpen(true);
      }}
      className={`flex-none whitespace-nowrap ${btnBase} ${btnGreen} h-11 px-3 py-2 text-[13px]`}
    >
      + Generate Quiz with AI
    </button>

    <button
      onClick={createQuiz}
      className={`flex-1 whitespace-nowrap ${btnBase} ${btnGray} h-11 px-3 py-2 text-[13px]`}
      disabled={creating}
    >
      {creating ? "Creating…" : "New empty quiz"}
    </button>
  </div>

  {/* Filters/search underneath */}
  <div className="mt-3 flex flex-wrap items-stretch gap-3">
    {/* Filter by group (moved above search) */}
    <div className="flex items-center gap-2 w-full">
      <label className="text-sm text-gray-300 shrink-0">Filter by group:</label>
      <select
        className="w-full rounded bg-gray-800 text-white border border-gray-700 px-3 py-2 h-11 text-[13px]"
        value={filterGroupId}
        onChange={(e) => setFilterGroupId(e.target.value)}
      >
        <option value="">All</option>
        <option value={NO_GROUP}>No group</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </div>

   {/* Search — full-width on mobile */}
<div className="w-full">
  <input
    className="block w-full rounded bg-gray-800 text-white border border-gray-700 px-3 py-2 h-11 text-[13px] placeholder:text-gray-400"
    placeholder="Search quizzes…"
    value={query}
    onChange={(e) => setQuery(e.target.value)}
  />
</div>

    {hasSelected && (
      <div className="ml-auto flex items-center gap-2">
        <button onClick={() => setMoveOpen(true)} className={`${btnBase} ${btnGray}`}>
          Move to group
        </button>
        <button onClick={() => setBulkConfirmOpen(true)} className={`${btnBase} ${btnRed}`}>
          Delete selected
        </button>
      </div>
    )}
  </div>
</div>

        {/* ---- DESKTOP/TABLET actions ---- */}
        <div className="mb-6 hidden sm:flex flex-wrap items-stretch gap-3 w-full">
          <button
            onClick={async () => {
              if (filterGroupId && filterGroupId !== NO_GROUP)
                setGGroupId(filterGroupId);
              else setGGroupId("");
              const allowed = await ensureCanCreate();
              if (!allowed) return;
              setGenOpen(true);
            }}
            className={`whitespace-normal text-left leading-tight ${btnBase} ${btnGreen} ${actionH}`}
          >
            + Generate Quiz with AI
          </button>

          <button
            onClick={createQuiz}
            className={`whitespace-normal text-left leading-tight ${btnBase} ${btnGray} ${actionH}`}
            disabled={creating}
          >
            {creating ? "Creating…" : "New empty quiz"}
          </button>

          <div className="flex-1 flex justify-end gap-3 w-full">
            <div className="flex-none w-64 md:w-80">
              <input
                className="w-full p-3 rounded bg-gray-800 text-white border border-gray-700 placeholder:text-gray-400"
                placeholder="Search quizzes…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div className="relative z-50 flex-none w-56 md:w-64 flex items-center">
              <label className="text-sm text-gray-300 mr-2 whitespace-nowrap">
                Filter by group:
              </label>
              <select
                className="relative z-50 w-full p-3 rounded bg-gray-800 text-white border border-gray-700"
                value={filterGroupId}
                onChange={(e) => setFilterGroupId(e.target.value)}
              >
                <option value="">All</option>
                <option value={NO_GROUP}>No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {hasSelected && (
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => setMoveOpen(true)}
                className={`${btnBase} ${btnGray}`}
              >
                Move to group
              </button>
              <button
                onClick={() => setBulkConfirmOpen(true)}
                className={`${btnBase} ${btnRed}`}
              >
                Delete selected
              </button>
            </div>
          )}
        </div>

        {/* ----------------------- QUIZ LIST / CAROUSEL ---------------------- */}
        {visibleQuizzes.length === 0 ? (
          <div className="text-gray-400">
            No quizzes yet. Create one or generate with AI.
          </div>
        ) : (
          <>
           {/* --- MOBILE vertical list --- */}
<div className="sm:hidden">
  <div className="relative">
    <div
      className="w-full pt-2 max-h-[72vh] overflow-y-auto overscroll-contain"
      aria-label="Your quizzes (scrollable list)"
    >
      <ul className="grid grid-cols-1 gap-3">
        {visibleQuizzes.map((q) => {
          const score = scoresByQuiz[q.id];
          const rvCount = q.review_questions?.length ?? 0;
          const reviewDisabled = rvCount === 0;

          return (
            <li
              key={q.id}
              className="w-full max-w-[580px] bg-gray-800 rounded-2xl p-4 shadow-sm border border-gray-800 flex flex-col overflow-hidden h-[360px]"
            >
              {/* Top: meta + preview */}
              <div className="flex-1 grid grid-cols-1 gap-3 min-h-0 overflow-hidden">
                {/* LEFT: title + meta */}
                <div className="min-w-0">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="h-5 w-5 accent-emerald-500 mt-1 shrink-0"
                      checked={selectedIds.has(q.id)}
                      onChange={() => toggleSelected(q.id)}
                      aria-label={`Select ${q.title || "Untitled Quiz"}`}
                    />
                    <div className="min-w-0">
                      <div
                        className="text-xl font-semibold leading-tight break-words"
                        title={q.title || "Untitled Quiz"}
                      >
                        {q.title || "Untitled Quiz"}
                      </div>

                      <div className="mt-2 text-xs text-gray-300 space-y-0.5">
                        <div>{q.questions?.length ?? 0} questions</div>
                        <div>
                          Last score:{" "}
                          {score?.last != null ? (
                            <span
                              className={
                                score.last >= 90 ? "text-green-400 font-semibold" : ""
                              }
                            >
                              {score.last}%
                            </span>
                          ) : (
                            "—"
                          )}
                        </div>
                        <div>
                          Revisit score:{" "}
                          {score?.review != null ? (
                            <span
                              className={
                                score.review >= 90 ? "text-green-400 font-semibold" : ""
                              }
                            >
                              {score.review}%
                            </span>
                          ) : (
                            "—"
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* RIGHT: Questions preview */}
                <div className="relative bg-gray-900/30 border border-gray-700 rounded-xl p-3 overflow-hidden">
                  <ol className="text-[13px] leading-5 list-decimal pl-5 pr-3 pb-7 space-y-1.5 max-h-[160px] overflow-hidden">
                    {(Array.isArray(q.questions) ? q.questions : []).map((it, idx) => {
                      const p = (it?.prompt || "").toString().trim();
                      if (!p) return null;
                      return (
                        <li key={idx} className="break-words">
                          {p}
                        </li>
                      );
                    })}
                  </ol>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-gray-900/95 to-transparent" />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end pr-3 pb-1.5 select-none">
                    <span>…</span>
                  </div>
                </div>
              </div>

              {/* Bottom actions */}
              <div className="mt-3 grid grid-cols-4 gap-2">
                <Link
                  to={`/play/${q.id}`}
                  className={`${btnBase} ${btnGray} h-11 p-0 flex items-center justify-center`}
                  aria-label="Play quiz"
                  title="Play"
                >
                  <Play className="h-5 w-5" />
                </Link>

                <Link
                  to={reviewDisabled ? "#" : `/play/${q.id}?mode=review`}
                  onClick={(e) => {
                    if (reviewDisabled) e.preventDefault();
                  }}
                  className={`${btnBase} ${btnGray} h-11 p-0 flex items-center justify-center ${
                    reviewDisabled ? "opacity-50 cursor-not-allowed" : ""
                  }`}
                  aria-label={reviewDisabled ? "No Revisit questions yet" : "Practice Revisit"}
                  title={reviewDisabled ? "No Revisit questions yet" : "Practice Revisit"}
                >
                  <History className="h-5 w-5" />
                </Link>

                <Link
                  to={`/edit/${q.id}`}
                  className={`${btnBase} ${btnGray} h-11 p-0 flex items-center justify-center`}
                  aria-label="Edit quiz"
                  title="Edit"
                >
                  <SquarePen className="h-5 w-5" />
                </Link>

                <button
                  onClick={() => {
                    setTarget({
                      id: q.id,
                      title: q.title || "Untitled Quiz",
                      group_id: q.group_id ?? null,
                    });
                    setConfirmOpen(true);
                  }}
                  className={`${btnBase} ${btnGray} h-11 p-0 flex items-center justify-center`}
                  aria-label="Delete quiz"
                  title="Delete"
                >
                  <Trash2 className="h-5 w-5" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  </div>
</div>

            {/* --- DESKTOP/TABLET horizontal carousel --- */}
            <div className="relative hidden sm:block overflow-x-clip">
              {canLeft && (
                <button
                  type="button"
                  onClick={scrollLeft}
                  className="absolute -left-4 top-1/2 -translate-y-1/2 z-10 bg-gray-800 hover:bg-gray-700 rounded-full p-3 shadow"
                  aria-label="Scroll left"
                  title="Scroll left"
                >
                  ‹
                </button>
              )}
              {canRight && (
                <button
                  type="button"
                  onClick={scrollRight}
                  className="absolute -right-4 top-1/2 -translate-y-1/2 z-10 bg-gray-800 hover:bg-gray-700 rounded-full p-3 shadow"
                  aria-label="Scroll right"
                  title="Scroll right"
                >
                  ›
                </button>
              )}

              <div
                ref={railRef}
                className="overflow-x-auto"
                onScroll={updateScrollButtons}
              >
                <ul className="flex gap-6 px-1 py-2 min-w-full">
                  {visibleQuizzes.map((q) => {
                    const score = scoresByQuiz[q.id];
                    const rvCount = q.review_questions?.length ?? 0;
                    const reviewDisabled = rvCount === 0;

                    return (
                      <li
                        key={q.id}
                        className="sm:snap-start shrink-0 w-[540px] max-w-[580px]
                                   bg-gray-800 rounded-3xl p-5 shadow-sm border border-gray-800
                                   h-[460px] flex flex-col overflow-hidden"
                      >
                        {/* Top content */}
                        <div className="flex-1 grid grid-cols-2 gap-4 min-h-0 overflow-hidden">
                          {/* LEFT: title + meta */}
                          <div className="min-w-0">
                            <div className="flex items-start gap-3">
                              <input
                                type="checkbox"
                                className="h-6 w-6 accent-emerald-500 mt-1 shrink-0"
                                checked={selectedIds.has(q.id)}
                                onChange={() => toggleSelected(q.id)}
                                aria-label={`Select ${q.title || "Untitled Quiz"}`}
                              />
                              <div className="min-w-0">
                                <div
                                  className="text-2xl font-semibold leading-tight break-words"
                                  title={q.title || "Untitled Quiz"}
                                >
                                  {q.title || "Untitled Quiz"}
                                </div>

                                <div className="mt-3 text-sm text-gray-300 space-y-1">
                                  <div>{q.questions?.length ?? 0} questions</div>
                                  <div>
                                    Last score:{" "}
                                    {score?.last != null ? (
                                      <span
                                        className={
                                          score.last >= 90
                                            ? "text-green-400 font-semibold"
                                            : ""
                                        }
                                      >
                                        {score.last}%
                                      </span>
                                    ) : (
                                      "—"
                                    )}
                                  </div>
                                  <div>
                                    Revisit score:{" "}
                                    {score?.review != null ? (
                                      <span
                                        className={
                                          score.review >= 90
                                            ? "text-green-400 font-semibold"
                                            : ""
                                        }
                                      >
                                        {score.review}%
                                      </span>
                                    ) : (
                                      "—"
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* RIGHT: Questions preview */}
                          <div className="relative bg-gray-900/30 border border-gray-700 rounded-2xl p-3 overflow-hidden">
                            <ol className="text-sm leading-6 list-decimal pl-5 pr-3 pb-8 space-y-2 max-h-[320px] overflow-hidden">
                              {(Array.isArray(q.questions) ? q.questions : []).map(
                                (it, idx) => {
                                  const p = (it?.prompt || "")
                                    .toString()
                                    .trim();
                                  if (!p) return null;
                                  return (
                                    <li key={idx} className="break-words">
                                      {p}
                                    </li>
                                  );
                                }
                              )}
                            </ol>
                            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-gray-900/95 to-transparent" />
                            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end pr-3 pb-2 select-none">
                              <span>…</span>
                            </div>
                          </div>
                        </div>

                        {/* Bottom actions */}
                        <div className="mt-4 grid grid-cols-4 gap-2">
                          <Link
                            to={`/play/${q.id}`}
                            className={`${btnBase} ${btnGray} h-12 sm:h-14 p-0 flex items-center justify-center`}
                            aria-label="Play quiz"
                            title="Play"
                          >
                            <Play className="h-6 w-6" />
                          </Link>

                          <Link
                            to={
                              reviewDisabled ? "#" : `/play/${q.id}?mode=review`
                            }
                            onClick={(e) => {
                              if (reviewDisabled) e.preventDefault();
                            }}
                            className={`${btnBase} ${btnGray} h-12 sm:h-14 p-0 flex items-center justify-center ${
                              reviewDisabled ? "opacity-50 cursor-not-allowed" : ""
                            }`}
                            aria-label={
                              reviewDisabled
                                ? "No Revisit questions yet"
                                : "Practice Revisit"
                            }
                            title={
                              reviewDisabled
                                ? "No Revisit questions yet"
                                : "Practice Revisit"
                            }
                          >
                            <History className="h-6 w-6" />
                          </Link>

                          <Link
                            to={`/edit/${q.id}`}
                            className={`${btnBase} ${btnGray} h-12 sm:h-14 p-0 flex items-center justify-center`}
                            aria-label="Edit quiz"
                            title="Edit"
                          >
                            <SquarePen className="h-6 w-6" />
                          </Link>

                          <button
                            onClick={() => {
                              setTarget({
                                id: q.id,
                                title: q.title || "Untitled Quiz",
                                group_id: q.group_id ?? null,
                              });
                              setConfirmOpen(true);
                            }}
                            className={`${btnBase} ${btnGray} h-12 sm:h-14 p-0 flex items-center justify-center`}
                            aria-label="Delete quiz"
                            title="Delete"
                          >
                            <Trash2 className="h-6 w-6" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </>
        )}

        {dbg("FOOTER check", { filterGroupId, isEmpty: filterGroupId === "", isNoGroup: filterGroupId === NO_GROUP, hasCurrent: !!currentGroup })}

        {/* ---------------- Footer actions + “Last score” ------------------- */}
{(() => {
  const hasAnyQuizzes = (quizzes?.length ?? 0) > 0;
  if (!hasAnyQuizzes) return null;

  const isAll = filterGroupId === "" || filterGroupId === ALL_GROUP_ID;
  const isNoGroup = filterGroupId === NO_GROUP;
  const isConcreteGroup =
    !!(filterGroupId && filterGroupId !== NO_GROUP && currentGroup);

  return (isAll || isNoGroup || isConcreteGroup) ? (
    <div className="mt-8 flex justify-center">
      {/* Mobile: full width; ≥sm: shrink to content */}
      <div className="w-full sm:w-auto">
        <div className="w-full sm:w-auto bg-gray-800/60 border border-gray-700 rounded-2xl p-5 sm:p-6 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between md:flex-nowrap gap-4">
            {/* LEFT: context + last scores */}
            <div className="text-base text-gray-300 space-y-2">
              <div>
                <span className="font-semibold text-white text-xl sm:text-2xl tracking-tight">
                  {isConcreteGroup
                    ? `${currentGroup.name} Group`
                    : isNoGroup
                    ? "“No group”"
                    : "All group"}
                </span>
              </div>

              {/* Revisit last score */}
              <div className="text-sm sm:text-base">
                <span className="text-gray-400">Revisit last score:</span>{" "}
                {isAll ? (
                  typeof allRevisitScore === "number" ? (
                    <span className={allRevisitScore >= 90 ? "text-green-400 font-semibold" : "text-white"}>
                      {allRevisitScore}%
                    </span>
                  ) : "—"
                ) : isConcreteGroup ? (
                  typeof groupRevisitScores.get(currentGroup.id) === "number" ? (
                    <span className={groupRevisitScores.get(currentGroup.id) >= 90 ? "text-green-400 font-semibold" : "text-white"}>
                      {groupRevisitScores.get(currentGroup.id)}%
                    </span>
                  ) : "—"
                ) : isNoGroup ? (
                  typeof groupRevisitScores.get(NO_GROUP_ID) === "number" ? (
                    <span className={groupRevisitScores.get(NO_GROUP_ID) >= 90 ? "text-green-400 font-semibold" : "text-white"}>
                      {groupRevisitScores.get(NO_GROUP_ID)}%
                    </span>
                  ) : "—"
                ) : "—"}
              </div>

              {/* All-Questions last score */}
              <div className="text-sm sm:text-base">
                <span className="text-gray-400">All-questions last score:</span>{" "}
                {isAll ? (
                  typeof allAllScore === "number" ? (
                    <span className={allAllScore >= 90 ? "text-green-400 font-semibold" : "text-white"}>
                      {allAllScore}%
                    </span>
                  ) : "—"
                ) : isConcreteGroup ? (
                  typeof groupAllScores.get(currentGroup.id) === "number" ? (
                    <span className={groupAllScores.get(currentGroup.id) >= 90 ? "text-green-400 font-semibold" : "text-white"}>
                      {groupAllScores.get(currentGroup.id)}%
                    </span>
                  ) : "—"
                ) : isNoGroup ? (
                  typeof groupAllScores.get(NO_GROUP_ID) === "number" ? (
                    <span className={groupAllScores.get(NO_GROUP_ID) >= 90 ? "text-green-400 font-semibold" : "text-white"}>
                      {groupAllScores.get(NO_GROUP_ID)}%
                    </span>
                  ) : "—"
                ) : "—"}
              </div>
            </div>

            {/* RIGHT: actions (icons only; larger) */}
            <div className="flex flex-col sm:flex-row md:flex-row md:flex-nowrap items-stretch gap-3">
              {isConcreteGroup ? (
                <>
                  <Link
                    to={groupReviewCount > 0 ? `/play/group/${currentGroup.id}?mode=review` : "#"}
                    onClick={(e) => groupReviewCount === 0 && e.preventDefault()}
                    className={`${btnBase} ${btnGray} inline-flex items-center justify-center min-h-[3.5rem] sm:min-h-[3.75rem] px-5 ${
                      groupReviewCount === 0 ? "opacity-50 cursor-not-allowed" : ""
                    }`}
                    title={
                      groupReviewCount === 0
                        ? "No Revisit questions in this group yet"
                        : `Play “${currentGroup.name}” Revisit Questions`
                    }
                    aria-label={`Play ${currentGroup.name} Revisit Questions`}
                  >
                    <History className="h-7 w-7 sm:h-8 sm:w-8 shrink-0" />
                  </Link>

                  <Link
                    to={groupAllCount > 0 ? `/play/group/${currentGroup.id}?mode=all` : "#"}
                    onClick={(e) => groupAllCount === 0 && e.preventDefault()}
                    className={`${btnBase} ${btnGreen} inline-flex items-center justify-center min-h-[3.5rem] sm:min-h-[3.75rem] px-5 ${
                      groupAllCount === 0 ? "opacity-50 cursor-not-allowed" : ""
                    }`}
                    title={
                      groupAllCount === 0
                        ? "No questions in this group yet"
                        : `Play “${currentGroup.name}” All Questions`
                    }
                    aria-label={`Play ${currentGroup.name} All Questions`}
                  >
                    <Play className="h-7 w-7 sm:h-8 sm:w-8 shrink-0" />
                  </Link>

                  <button
                    onClick={openEditGroup}
                    className={`${btnBase} ${btnGray} inline-flex items-center justify-center min-h-[3.5rem] sm:min-h-[3.75rem] px-5`}
                    title="Edit this group’s name"
                    aria-label="Edit group name"
                  >
                    <SquarePen className="h-8 w-8" strokeWidth={2} />
                  </button>

                  <button
                    onClick={() => setDeleteGroupOpen(true)}
                    className={`${btnBase} ${btnRed} inline-flex items-center justify-center min-h-[3.5rem] sm:min-h-[3.75rem] px-5`}
                    title={`Delete “${currentGroup.name}” and all its quizzes`}
                    aria-label={`Delete ${currentGroup.name} group`}
                  >
                    <Trash2 className="h-8 w-8" strokeWidth={2} />
                  </button>
                </>
              ) : isNoGroup ? (
                <>
                  <Link
                    to={noGroupReviewCount > 0 ? `/play/group/${NO_GROUP_ID}?mode=review` : "#"}
                    onClick={(e) => noGroupReviewCount === 0 && e.preventDefault()}
                    className={`${btnBase} ${btnGray} inline-flex items-center justify-center min-h-[3.5rem] sm:min-h-[3.75rem] px-5 ${
                      noGroupReviewCount === 0 ? "opacity-50 cursor-not-allowed" : ""
                    }`}
                    title={
                      noGroupReviewCount === 0
                        ? "No Revisit questions in No group yet"
                        : "Play “No group” Revisit Questions"
                    }
                    aria-label="Play No group Revisit Questions"
                  >
                    <History className="h-7 w-7 sm:h-8 sm:w-8 shrink-0" />
                  </Link>

                  <Link
                    to={noGroupAllCount > 0 ? `/play/group/${NO_GROUP_ID}?mode=all` : "#"}
                    onClick={(e) => noGroupAllCount === 0 && e.preventDefault()}
                    className={`${btnBase} ${btnGreen} inline-flex items-center justify-center min-h-[3.5rem] sm:min-h-[3.75rem] px-5 ${
                      noGroupAllCount === 0 ? "opacity-50 cursor-not-allowed" : ""
                    }`}
                    title={
                      noGroupAllCount === 0
                        ? "No questions in No group yet"
                        : "Play “No group” All Questions"
                    }
                    aria-label="Play No group All Questions"
                  >
                    <Play className="h-7 w-7 sm:h-8 sm:w-8 shrink-0" />
                  </Link>
                </>
              ) : (
                <>
                  {/* Treat "" and ALL_GROUP_ID as All */}
                  <Link
                    to={allReviewCount > 0 ? `/play/all?mode=review` : "#"}
                    onClick={(e) => allReviewCount === 0 && e.preventDefault()}
                    className={`${btnBase} ${btnGray} inline-flex items-center justify-center min-h-[3.5rem] sm:min-h-[3.75rem] px-6 ${
                      allReviewCount === 0 ? "opacity-50 cursor-not-allowed" : ""
                    }`}
                    title={
                      allReviewCount === 0
                        ? "No Revisit questions yet"
                        : "Play Revisit Questions (All quizzes)"
                    }
                    aria-label="Play Revisit Questions (All)"
                  >
                    <History className="h-7 w-7 sm:h-8 sm:w-8 shrink-0" />
                  </Link>

                  <Link
                    to={allAllCount > 0 ? `/play/all?mode=all` : "#"}
                    onClick={(e) => allAllCount === 0 && e.preventDefault()}
                    className={`${btnBase} ${btnGreen} inline-flex items-center justify-center min-h-[3.5rem] sm:min-h-[3.75rem] px-6 ${
                      allAllCount === 0 ? "opacity-50 cursor-not-allowed" : ""
                    }`}
                    title={
                      allAllCount === 0
                        ? "No questions yet"
                        : "Play All Questions (All quizzes)"
                    }
                    aria-label="Play All Questions (All)"
                  >
                    <Play className="h-7 w-7 sm:h-8 sm:w-8 shrink-0" />
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  ) : null;
})()}




      </main>

      {/* ------------------------------ Modals ------------------------------- */}
      {confirmOpen && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-50"
          aria-modal="true"
          role="dialog"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (deleting) return;
            if (e.key === "Escape") setConfirmOpen(false);
            if (e.key === "Enter") setConfirmOpen(false);
          }}
          onClick={() => !deleting && setConfirmOpen(false)}
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2">Delete quiz?</h2>
            <p className="text-gray-300 mb-6">
              Are you sure you want to delete{" "}
              <span className="font-semibold">{target?.title}</span>?
            </p>
            <div className="flex flex-col sm:flex-row justify-end gap-2">
              <button
                className={`${btnBase} ${btnGray}`}
                onClick={() => setConfirmOpen(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className={`${btnBase} ${btnGray}`}
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
{accountOpen && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-[96]"
          aria-modal="true"
          role="dialog"
          onClick={() => {
            if (!accountDeleting) {
              setAccountOpen(false);
              setAccountConfirmOpen(false);
              setAccountError("");
            }
          }}
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-4">Account</h2>

            <button
  className={`${btnBase} ${btnRed} mb-6 px-6 mx-auto block`}
  onClick={() => {
    if (!accountDeleting) {
      setAccountConfirmOpen(true);
    }
  }}
  disabled={accountDeleting}
>
  Delete Account
</button>
            <p className="text-gray-300 text-sm">
              Feedback? -{" "}
              <span className="text-gray-300 text-sm">support@smart-quiz.app</span>
            </p>

            {accountError && (
              <p className="mt-3 text-sm text-red-400 break-words">
                {accountError}
              </p>
            )}

            <div className="mt-5 flex justify-end">
              <button
                className={`${btnBase} ${btnGray}`}
                onClick={() => {
                  if (!accountDeleting) {
                    setAccountOpen(false);
                    setAccountConfirmOpen(false);
                    setAccountError("");
                  }
                }}
                disabled={accountDeleting}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {accountConfirmOpen && (
        <div
          className="fixed inset-0 bg-black/70 grid place-items-center z-[97]"
          aria-modal="true"
          role="dialog"
          onClick={() => {
            if (!accountDeleting) setAccountConfirmOpen(false);
          }}
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-3">Delete account?</h2>
            <p className="text-gray-300 mb-6 text-sm">
              Are you sure you want to delete your account? This action will
              delete all your quizzes.
            </p>
            <div className="flex flex-col sm:flex-row justify-end gap-2">
              <button
                className={`${btnBase} ${btnGray}`}
                onClick={() => !accountDeleting && setAccountConfirmOpen(false)}
                disabled={accountDeleting}
              >
                Cancel
              </button>
              <button
                className={`${btnBase} ${btnRed}`}
                onClick={performAccountDeletion}
                disabled={accountDeleting}
              >
                {accountDeleting ? "Deleting…" : "Yes, delete my account"}
              </button>
            </div>
          </div>
        </div>
      )}
      {authOpen && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-[95]"
          onClick={() => {
            if (!authBusy) {
              setAuthMessage("");
              setAuthOpen(false);
            }
          }}
          aria-modal="true"
          role="dialog"
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2">
              Create account or sign in
            </h2>

            {authMessage && (
              <div className="mb-4 rounded-lg bg-emerald-900/30 border border-emerald-800 p-3 text-sm">
                {authMessage}
              </div>
            )}

            <p className="text-gray-300 mb-4 text-sm">
              Creating an account upgrades your current guest session so your
              quizzes stay with you.
            </p>

            <label
              className="block text-sm text-gray-300 mb-1"
              htmlFor="auth-email"
            >
              Email
            </label>
            <input
              id="auth-email"
              className="w-full p-3 rounded bg-gray-900 text-white border border-gray-700 mb-3"
              type="email"
              placeholder="you@example.com"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              autoFocus
            />

            <label
              className="block text-sm text-gray-300 mb-1"
              htmlFor="auth-pass"
            >
              Password
            </label>
            <input
              id="auth-pass"
              className="w-full p-3 rounded bg-gray-900 text-white border border-gray-700 mb-4"
              type="password"
              placeholder="••••••••"
              value={authPass}
              onChange={(e) => setAuthPass(e.target.value)}
            />

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                className={`${btnBase} ${btnGray} w-full`}
                onClick={() => {
                  if (!authBusy) {
                    setAuthMessage("");
                    setAuthOpen(false);
                  }
                }}
                disabled={authBusy}
              >
                Not now
              </button>

              <button
                className={`${btnBase} ${btnGreen} w-full`}
                onClick={handleCreateAccount}
                disabled={authBusy}
                title="Upgrade this guest to an email/password account"
              >
                {authBusy ? "Working…" : "Create account"}
              </button>

              <button
                className={`${btnBase} ${btnGray} w-full`}
                onClick={async () => {
                  const ok = confirm(
                    "Signing in to an existing account will replace your guest session. Continue?"
                  );
                  if (ok) await signInExisting();
                }}
                disabled={authBusy}
                title="Sign in instead (replaces guest session)"
              >
                Sign in instead
              </button>
            </div>

            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={continueWithGoogle}
                className="h-12 w-12 rounded-full bg-white border border-gray-300 shadow flex items-center justify-center hover:shadow-md active:scale-95 transition"
                aria-label="Continue with Google"
                title="Continue with Google"
                disabled={authBusy}
              >
                <svg width="24" height="24" viewBox="0 0 48 48" aria-hidden="true">
                  <path
                    fill="#FFC107"
                    d="M43.6 20.5H42V20H24v8h11.3C33.6 32.4 29.2 35 24 35c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C33.8 5.1 29.2 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21c10.5 0 20-7.6 20-21 0-1.3-.1-2.7-.4-3.5z"
                  />
                  <path
                    fill="#FF3D00"
                    d="M6.3 14.7l6.6 4.8C14.5 16 19 13 24 13c3 0 5.8 1.1 7.9 3l5.7-5.7C33.8 5.1 29.2 3 24 3 16 3 8.9 7.6 6.3 14.7z"
                  />
                  <path
                    fill="#4CAF50"
                    d="M24 45c5.1 0 9.8-1.9 13.3-5.1l-6.1-5c-2 1.5-4.6 2.4-7.2 2.4-5.2 0-9.6-3.5-11.2-8.3L6.2 33.9C8.8 41 16 45 24 45z"
                  />
                  <path
                    fill="#1976D2"
                    d="M43.6 20.5H42V20H24v8h11.3c-1.1 3.1-3.6 5.6-6.6 6.9l6.1 5C37.8 37.9 41 31.9 41 24c0-1.3-.1-2.7-.4-3.5z"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {genOpen && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-50"
          aria-modal="true"
          role="dialog"
          onClick={() => !generating && setGenOpen(false)}
        >
          <div
            className="w-full max-w-xl bg-gray-800 text-white rounded-2xl p-6 shadow-xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-4">Generate a quiz</h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-sm text-gray-300 mb-1" htmlFor="gen-title">
                  Name
                </label>
                <input
                  id="gen-title"
                  className="field w-full placeholder:text-gray-400"
                  placeholder="Bash Top 10"
                  value={gTitle}
                  onChange={(e) => setGTitle(e.target.value)}
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-sm text-gray-300 mb-1" htmlFor="gen-topic">
                  Prompt
                </label>
                <textarea
                  id="gen-topic"
                  className="field-textarea w-full min-h-[8rem] resize-y placeholder:text-gray-400"
                  placeholder="Create 10 questions that test the 10 most-used Bash commands."
                  value={gTopic}
                  onChange={(e) => setGTopic(e.target.value)}
                />
              </div>

              <div className="sm:col-span-2">
                <label className="inline-flex items-center gap-2 text-sm text-gray-200">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={gNoRepeat}
                    onChange={(e) => setGNoRepeat(e.target.checked)}
                  />
                  <span>Do not repeat previous questions</span>
                </label>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-sm text-gray-300 mb-1" htmlFor="gen-file">
                  Optional document to use as source (PDF / TXT / MD)
                </label>
                <input
                  id="gen-file"
                  type="file"
                  accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
                  className="w-full p-3 rounded bg-gray-800 text-white border border-gray-700"
                  onChange={(e) => setGFile(e.target.files?.[0] ?? null)}
                />
                {gFile && (
                  <div className="mt-1 text-xs text-gray-300">
                    Selected: {gFile.name}{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => setGFile(null)}
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>

              <div className="sm:col-span-1">
                <label className="block text-sm text-gray-300 mb-1" htmlFor="gen-group">
                  Add to Group
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <select
                    id="gen-group"
                    className="w-full p-3 rounded bg-gray-800 text-white border border-gray-700"
                    value={gGroupId}
                    onChange={(e) => setGGroupId(e.target.value)}
                  >
                    <option value="">No group</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={`${btnBase} ${btnGray}`}
                    onClick={() => {
                      setGNewName("");
                      setGNewOpen(true);
                    }}
                  >
                    New group +
                  </button>
                </div>
              </div>

              <div className="sm:col-span-1">
                <label className="block text-sm text-gray-300 mb-1" htmlFor="gen-count">
                  # of questions
                </label>
                <input
                  id="gen-count"
                  className="field w-full sm:w-20 text-left pl-4"
                  type="number"
                  min={1}
                  max={30}
                  value={gCount}
                  onChange={(e) => setGCount(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="flex flex-col sm:flex-row justify-end gap-2 mt-6">
              <button
                className={`${btnBase} ${btnGray}`}
                onClick={() => setGenOpen(false)}
                disabled={generating}
              >
                Cancel
              </button>
              <button
                className={`${btnBase} ${btnGreen}`}
                onClick={generateQuiz}
                disabled={generating}
              >
                {generating ? "Generating…" : "Generate"}
              </button>
            </div>
          </div>
        </div>
      )}

      {gNewOpen && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-50"
          aria-modal="true"
          role="dialog"
          onClick={() => !gCreatingGroup && setGNewOpen(false)}
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-4">Create new group</h2>
            <input
              className="w-full p-3 rounded bg-gray-800 text-white border border-gray-700"
              placeholder="Group name"
              value={gNewName}
              onChange={(e) => setGNewName(e.target.value)}
            />
            <div className="flex justify-end gap-2 mt-6">
              <button
                className={`${btnBase} ${btnGray}`}
                onClick={() => setGNewOpen(false)}
                disabled={gCreatingGroup}
              >
                Cancel
              </button>
              <button
                className={`${btnBase} ${btnGreen}`}
                onClick={createGroupForModal}
                disabled={gCreatingGroup || !gNewName.trim()}
              >
                {gCreatingGroup ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {bulkConfirmOpen && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-50"
          aria-modal="true"
          role="dialog"
          onClick={() => !bulkDeleting && setBulkConfirmOpen(false)}
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2">
              Delete selected quizzes?
            </h2>
            <p className="text-gray-300 mb-4">
              You have selected:
              <span className="block mt-1 font-semibold break-words">
                {Array.from(selectedIds).length
                  ? Array.from(selectedIds).join(", ")
                  : "None"}
              </span>
            </p>
            <div className="flex flex-col sm:flex-row justify-end gap-2">
              <button
                className={`${btnBase} ${btnGray}`}
                onClick={() => setBulkConfirmOpen(false)}
                disabled={bulkDeleting}
              >
                Cancel
              </button>
              <button
                className={`${btnBase} ${btnRedSoft}`}
                onClick={doBulkDelete}
                disabled={bulkDeleting}
              >
                {bulkDeleting ? "Deleting…" : "Delete selected"}
              </button>
            </div>
          </div>
        </div>
      )}

      {moveOpen && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-50"
          aria-modal="true"
          role="dialog"
          onClick={() => !moving && setMoveOpen(false)}
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-4">Move selected to group</h2>
            <p className="text-gray-300 mb-4">
              Selected: <span className="font-semibold">{selectedIds.size}</span>{" "}
              {selectedIds.size === 1 ? "quiz" : "quizzes"}
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-300 mb-1">
                  Choose existing group (or leave blank for “No group”)
                </label>
                <select
                  className="w-full p-3 rounded bg-gray-800 text-white border border-gray-700"
                  value={moveGroupId}
                  onChange={(e) => setMoveGroupId(e.target.value)}
                >
                  <option value="">No group</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-gray-300 mb-1">
                  Or create a new group
                </label>
                <input
                  className="w-full p-3 bg-white rounded bg-gray-800 text-white border border-gray-700"
                  placeholder="New group name (optional)"
                  value={moveNewName}
                  onChange={(e) => setMoveNewName(e.target.value)}
                />
                <p className="text-xs text-gray-400 mt-1">
                  If you enter a name here, a new group will be created and
                  used.
                </p>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row justify-end gap-2 mt-6">
              <button
                className={`${btnBase} ${btnGray}`}
                onClick={() => setMoveOpen(false)}
                disabled={moving}
              >
                Cancel
              </button>
              <button
                className={`${btnBase} ${btnGreen}`}
                onClick={doBulkMove}
                disabled={moving || selectedIds.size === 0}
                title={selectedIds.size === 0 ? "No quizzes selected" : ""}
              >
                {moving ? "Moving…" : "Move"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteGroupOpen && currentGroup && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-50"
          aria-modal="true"
          role="dialog"
          onClick={() => !deletingGroup && setDeleteGroupOpen(false)}
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2">Delete group?</h2>
            <p className="text-gray-300 mb-6">
              This deletes the group{" "}
              <span className="font-semibold">{currentGroup.name}</span> and all
              quizzes inside it.
            </p>
            <div className="flex flex-col sm:flex-row justify-end gap-2">
              <button
                className={`${btnBase} ${btnGray}`}
                onClick={() => setDeleteGroupOpen(false)}
                disabled={deletingGroup}
              >
                Cancel
              </button>
              <button
                className={`${btnBase} ${btnRed}`}
                onClick={deleteCurrentGroupNow}
                disabled={deletingGroup}
              >
                {deletingGroup ? "Deleting…" : "Delete group"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editGroupOpen && currentGroup && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-50"
          aria-modal="true"
          role="dialog"
          onClick={() => !savingGroupName && setEditGroupOpen(false)}
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-4">Rename group</h2>
            <input
              className="w-full p-3 rounded bg-gray-800 text-white border border-gray-700"
              value={editGroupName}
              onChange={(e) => setEditGroupName(e.target.value)}
              placeholder="Group name"
            />
            <div className="flex flex-col sm:flex-row justify-end gap-2 mt-6">
              <button
                className={`${btnBase} ${btnGray}`}
                onClick={() => setEditGroupOpen(false)}
                disabled={savingGroupName}
              >
                Cancel
              </button>
              <button
                className={`${btnBase} ${btnGreen}`}
                onClick={saveGroupName}
                disabled={savingGroupName || !editGroupName.trim()}
              >
                {savingGroupName ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {cleanupOpen && cleanupGroup && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-50"
          aria-modal="true"
          role="dialog"
          onClick={() => !cleaning && setCleanupOpen(false)}
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2">Delete empty group?</h2>
            <p className="text-gray-300 mb-6">
              The group{" "}
              <span className="font-semibold">{cleanupGroup.name}</span> is now
              empty. Would you like to delete it?
            </p>
            <div className="flex flex-col sm:flex-row justify-end gap-2">
              <button
                className={`${btnBase} ${btnGray}`}
                onClick={keepEmptyGroupNow}
                disabled={cleaning}
              >
                Keep group
              </button>
              <button
                className={`${btnBase} ${btnRed}`}
                onClick={deleteEmptyGroupNow}
                disabled={cleaning}
              >
                {cleaning ? "Deleting…" : "Delete group"}
              </button>
            </div>
          </div>
        </div>
      )}

      {generating && (
        <div className="fixed inset-0 z-[120] bg-black/70 flex items-center justify-center">
          <div className="w-40 h-40 sm:w-48 sm:h-48 rounded-full bg-emerald-500 flex flex-col items-center justify-center shadow-2xl animate-pulse">
            <div className="text-gray-900 font-semibold text-xl sm:text-2xl select-none">
              Generating
            </div>
            <div className="flex gap-1 mt-1 text-gray-900 text-2xl leading-none select-none">
              <span className="animate-bounce [animation-delay:0ms]">•</span>
              <span className="animate-bounce [animation-delay:150ms]">•</span>
              <span className="animate-bounce [animation-delay:300ms]">•</span>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}