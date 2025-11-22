// src/pages/Dashboard.jsx
import { Play, History, SquarePen, Trash2, Mail, PanelRight, Download, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { copyShareLinkToClipboard } from "../lib/shareLinks";
import { storeGuestId } from "../auth/guestStorage";

import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/build/pdf.mjs";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { getInitialGroupFromUrlOrStorage, persistLastGroup } from "../lib/groupFilter";
import { useLocation } from "react-router-dom";
import SigningInOverlay from "../components/SigningInOverlay";
/* ------------------------------- CONSTANTS -------------------------------- */
const ALL_GROUP_ID = "00000000-0000-0000-0000-000000000000"; // sentinel for “All”
const NO_GROUP_SENTINEL = "__no_group__";
const NO_GROUP_LABEL = "No group";

function sortGroupsByName(list) {
  return [...list].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

function dbg() { }

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
  const { user, ready, signout, signin, signup, oauthOrLink, ensureSession } = useAuth();

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

  const pressAnim = "transition-transform duration-150 active:scale-[0.97] transition-colors";
  const btnBase =
    "btn-sentence px-4 py-2 rounded-2xl font-semibold tracking-tight disabled:opacity-50 disabled:cursor-not-allowed";
  const btnGray = `bg-white/10 hover:bg-white/20 text-white ${pressAnim}`;
  const btnGreen = `bg-emerald-500/90 hover:bg-emerald-400 text-slate-950 ${pressAnim}`;
  const btnRed = `bg-rose-600/80 hover:bg-rose-500 text-white ${pressAnim}`;
  const btnRedSoft = `bg-rose-500/70 hover:bg-rose-500 text-white ${pressAnim}`;
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
    // snapshot available in devtools if needed
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

      // 🔑 Remember which anonymous user to merge later
      if (user && isAnon) {
        try {
          storeGuestId(user.id);
        } catch { }
      }

      const { error } = await signup(email, password);
      if (error) {
        alert(error.message || "Failed to start signup.");
        return;
      }
      setAuthMessage("Check your email to confirm your account, then return here.");
    } catch (err) {
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

      // 🔑 Remember which anonymous user to merge into the existing account
      if (user && isAnon) {
        try {
          storeGuestId(user.id);
        } catch { }
      }

      const res = await signin(email, password);

      // If your AuthProvider.signin returns { error }, handle it here:
      if (res?.error) {
        alert(res.error.message || "Failed to sign in.");
        return;
      }

      setAuthMessage("");
      setAuthOpen(false);
    } catch (err) {
      // <-- Show the actual Supabase error message instead of generic text
      console.error("Sign-in error:", err);
      alert(err?.message || "Something went wrong during sign in.");
    } finally {
      setAuthBusy(false);
    }
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
        setAccountError(
          "Could not delete your account. Please try again, or email support@smart-quiz.app."
        );
        return;
      }

      // Success: sign out, close Account modal, redirect
      resetGroupFilterToAll();
      await signout();
      setAccountOpen(false);
      window.location.href = "/";
    } catch (err) {
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
  const [shareCopiedPulse, setShareCopiedPulse] = useState(false);
  const sharePulseTimer = useRef(null);

  useEffect(() => {
    return () => {
      if (sharePulseTimer.current) {
        clearTimeout(sharePulseTimer.current);
      }
    };
  }, []);

  const [genOpen, setGenOpen] = useState(false);
  const [gTitle, setGTitle] = useState("");
  const [gTopic, setGTopic] = useState("");
  const [gCount, setGCount] = useState(10);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [gGroupId, setGGroupId] = useState(NO_GROUP_SENTINEL);
  const [gFile, setGFile] = useState(null);
  const [gNoRepeat, setGNoRepeat] = useState(true);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [downloadingTranscript, setDownloadingTranscript] = useState(false);

  const [gNewOpen, setGNewOpen] = useState(false);
  const [gNewName, setGNewName] = useState("");
  const [gCreatingGroup, setGCreatingGroup] = useState(false);

  // Animated "Generating..." dots for overlay
  const [genDots, setGenDots] = useState(".");

  const location = useLocation();

  const [groups, setGroups] = useState([]);
  const [filterGroupId, setFilterGroupId] = useState(() =>
    getInitialGroupFromUrlOrStorage(location.search) || ""
  );
  const resetGroupFilterToAll = useCallback(() => {
    setFilterGroupId("");
    persistLastGroup("");
    try {
      const params = new URLSearchParams(location.search);
      if (params.has("group")) {
        params.delete("group");
        const nextSearch = params.toString();
        nav(
          {
            pathname: location.pathname,
            search: nextSearch ? `?${nextSearch}` : "",
          },
          { replace: true }
        );
      }
    } catch { }
  }, [location.pathname, location.search, nav]);
  const [hydrated, setHydrated] = useState(false);
  const normalizedFilterGroupId = filterGroupId || "";

  const orderedGroups = useMemo(() => {
    if (!groups?.length) return [];
    return sortGroupsByName(groups);
  }, [groups]);
  const noGroupRow = useMemo(() => {
    return (
      orderedGroups.find(
        (g) => (g.name || "").trim().toLowerCase() === NO_GROUP_LABEL.toLowerCase()
      ) || null
    );
  }, [orderedGroups]);
  const noGroupOptionValue = noGroupRow?.id ?? NO_GROUP_SENTINEL;
  const selectableGroupOptions = useMemo(() => {
    if (!orderedGroups.length) return [];
    if (!noGroupRow?.id) return orderedGroups;
    return orderedGroups.filter((g) => g.id !== noGroupRow.id);
  }, [orderedGroups, noGroupRow?.id]);

  useEffect(() => {
    const desired = noGroupOptionValue;
    if (!gGroupId || gGroupId === NO_GROUP_SENTINEL) {
      if (gGroupId !== desired) {
        setGGroupId(desired);
      }
      return;
    }
    const exists = orderedGroups.some((g) => g.id === gGroupId);
    if (!exists && gGroupId !== desired) {
      setGGroupId(desired);
    }
  }, [gGroupId, noGroupOptionValue, orderedGroups]);
  const currentGroup = normalizedFilterGroupId
    ? groups.find((g) => g.id === normalizedFilterGroupId) || null
    : null;
  const activeGroup = currentGroup;
  const isAllFilter = !normalizedFilterGroupId;

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

  const [expandedMenuId, setExpandedMenuId] = useState(null);
  function toggleMenu(id) {
    setExpandedMenuId(prev => prev === id ? null : id);
  }

  const [query, setQuery] = useState("");

  async function handleSignOut() {
    resetGroupFilterToAll();
    await signout();
    setAuthMessage(
      "You’re signed out. Sign in or create an account to save your progress."
    );
    setAuthOpen(true);
  }

  async function load() {
    const { data, error } = await supabase
      .from("quizzes")
      .select("id, title, questions, review_questions, updated_at, group_id")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false });
    if (error) {
      setQuizzes([]);
      setScoresByQuiz({});
      setAllRevisitScore(null);
      setGroupRevisitScores(new Map());
      setAllAllScore(null);
      setGroupAllScores(new Map());
      setHydrated(true);
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
      setHydrated(true);
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
      const key = r.group_id;
      if (!key) continue;
      if (!mReview.has(key) && typeof r.last_review_score === "number") {
        mReview.set(key, r.last_review_score);
      }
      if (!mAll.has(key) && typeof r.last_all_score === "number") {
        mAll.set(key, r.last_all_score);
      }
    }

    setGroupRevisitScores(mReview);
    setGroupAllScores(mAll);
    setHydrated(true);
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
  }, [ready, user?.id]);

  useEffect(() => {
    if (!ready) setHydrated(false);
  }, [ready]);

  useEffect(() => {
    if (!user?.id) {
      setFilterGroupId("");
      setHydrated(false);
    }
  }, [user?.id]);

  useEffect(() => {
    persistLastGroup(filterGroupId || "");
  }, [filterGroupId]);

  useEffect(() => {
    const initial = getInitialGroupFromUrlOrStorage(location.search) || "";
    setFilterGroupId(initial);
  }, [location.search]);

  const fetchGroups = useCallback(async () => {
    if (!user?.id) {
      setGroups([]);
      return;
    }
    const { data, error } = await supabase
      .from("groups")
      .select("id, name")
      .eq("user_id", user.id)
      .order("name", { ascending: true });
    if (error) {
      setGroups([]);
      return;
    }
    setGroups(sortGroupsByName(data ?? []));
  }, [user?.id]);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

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

  const ensureGroupSelection = useCallback(
    async (selectionId) => {
      if (!user?.id) return null;
      if (selectionId && selectionId !== NO_GROUP_SENTINEL) {
        return selectionId;
      }
      if (noGroupRow?.id) return noGroupRow.id;
      const fallbackRow = async () => {
        try {
          const { data: existing } = await supabase
            .from("groups")
            .select("id, name")
            .eq("user_id", user.id)
            .eq("name", NO_GROUP_LABEL)
            .maybeSingle();
          if (existing?.id) {
            setGroups((gs) => {
              if (gs.some((g) => g.id === existing.id)) return gs;
              return sortGroupsByName([...gs, existing]);
            });
            return existing.id;
          }
          return null;
        } catch {
          return null;
        }
      };
      try {
        const { data, error } = await supabase
          .from("groups")
          .insert({ user_id: user.id, name: NO_GROUP_LABEL })
          .select("id, name")
          .single();
        if (error || !data?.id) {
          const recovered = await fallbackRow();
          if (recovered) return recovered;
          throw error || new Error("Missing No group id");
        }
        setGroups((gs) => sortGroupsByName([...gs, data]));
        return data.id;
      } catch {
        const recovered = await fallbackRow();
        if (recovered) return recovered;
        alert("Failed to prepare the “No group” bucket. Please try again.");
        return null;
      }
    },
    [noGroupRow?.id, supabase, user?.id]
  );

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
      const targetGroupId = await ensureGroupSelection(
        normalizedFilterGroupId || noGroupOptionValue
      );
      if (!targetGroupId) return;
      const { data, error } = await supabase
        .from("quizzes")
        .insert({
          user_id: user.id,
          title: "Untitled Quiz",
          questions: [],
          group_id: targetGroupId,
        })
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

  async function handleShareQuiz(quizId, title) {
    try {
      const url = await copyShareLinkToClipboard(supabase, quizId);
      if (sharePulseTimer.current) clearTimeout(sharePulseTimer.current);
      setShareCopiedPulse(true);
      sharePulseTimer.current = setTimeout(() => {
        setShareCopiedPulse(false);
      }, 750);
    } catch (err) {
      console.error("Failed to create/copy share link", err);
      alert("Could not create a share link. Please try again.");
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

  async function handleDownloadTranscript() {
    if (!youtubeUrl || downloadingTranscript) return;

    // Validate URL
    const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
    if (!ytRegex.test(youtubeUrl)) {
      alert("Please enter a valid YouTube URL.");
      return;
    }

    setDownloadingTranscript(true);
    try {
      const { data: sessionRes } = await supabase.auth.getSession();
      const jwt = sessionRes?.session?.access_token;

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/index-source`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
          },
          body: JSON.stringify({ youtube_url: youtubeUrl, fetch_only: true }),
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        let msg = errText;
        if (errText.includes("Transcript is disabled")) {
          msg = "This video does not have captions/transcripts available.";
        } else if (errText.includes("No transcript found")) {
          msg = "No transcript could be found for this video.";
        }
        alert(`Failed to download transcript:\n${msg}`);
        return;
      }

      const data = await res.json();
      const transcript = data.transcript;

      if (!transcript) {
        alert("No transcript content returned.");
        return;
      }

      // Create blob and download
      const blob = new Blob([transcript], { type: "text/plain" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "transcript.txt";
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

    } catch (e) {
      alert(`Error downloading transcript: ${e.message}`);
    } finally {
      setDownloadingTranscript(false);
    }
  }

  async function generateQuiz() {
    try {
      if (generating) return;

      // ✅ make sure we *have* a session before reading jwt / calling functions
      await ensureSession("before-generate");

      const allowed = await ensureCanCreate();
      if (!allowed) return;
      setGenerating(true);

      console.log("[Generate] Starting", {
        gGroupId,
        groupsCount: groups.length,
      });

      const { data: sessionRes } = await supabase.auth.getSession();
      const jwt = sessionRes?.session?.access_token;
      const count = Math.max(1, Math.min(Number(gCount) || 10, 30));

      const resolvedGroupId = await ensureGroupSelection(gGroupId);
      if (!resolvedGroupId) {
        setGenerating(false);
        return;
      }

      console.log("[Generate] Resolved target group", {
        chosenGroupId: resolvedGroupId,
      });

      const targetGroupIdForNoRepeat = resolvedGroupId;

      let file_id = null;
      let sourceType = "document";

      if (youtubeUrl) {
        // Validate URL
        const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
        if (!ytRegex.test(youtubeUrl)) {
          alert("Please enter a valid YouTube URL.");
          setGenerating(false);
          return;
        }

        sourceType = "youtube";
        const idxRes = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/index-source`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
            },
            body: JSON.stringify({ youtube_url: youtubeUrl }),
          }
        );
        const idxText = await idxRes.text();
        if (!idxRes.ok) {
          let msg = idxText;
          if (idxText.includes("Transcript is disabled")) {
            msg = "This video does not have captions/transcripts available. Please try a different video.";
          } else if (idxText.includes("No transcript found")) {
            msg = "No transcript could be found for this video. Please try a different video.";
          }
          alert(`Failed to index YouTube video:\n${msg}`);
          setGenerating(false);
          return;
        }
        let idxOut = {};
        try {
          idxOut = idxText ? JSON.parse(idxText) : {};
        } catch { }
        file_id = idxOut?.file_id ?? null;
        if (!file_id) {
          alert("Indexing returned no file_id.");
          setGenerating(false);
          return;
        }
      } else if (gFile) {
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
        } catch { }
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
            group_id: resolvedGroupId,
            file_id,
            no_repeat: !!gNoRepeat,
            avoid_prompts,
            source_type: sourceType,
          }),
        }
      );

      let raw = "";
      try {
        raw = await res.text();
      } catch { }

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

      console.log("[Generate] Quiz generation succeeded, reloading dashboard…");

      setGenOpen(false);
      if (gFile) setGFile(null);
      setGenerating(false);
      await load();
    } catch (e) {
      console.log("[Generate] Failed with error:", e);
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
        setGroups((gs) => sortGroupsByName([...gs, data]));
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
        setGroups((gs) => sortGroupsByName([...gs, g]));
        targetGroupId = g.id;
      } else if (!targetGroupId) {
        alert("Select a destination group or enter a new name.");
        setMoving(false);
        return;
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
        sortGroupsByName(
          gs.map((g) => (g.id === currentGroup.id ? { ...g, name: data.name } : g))
        )
      );
      setEditGroupOpen(false);
    } catch (e) {
      alert("Failed to rename group. Please try again.");
    } finally {
      setSavingGroupName(false);
    }
  }

  const filteredQuizzes = useMemo(() => {
    if (!normalizedFilterGroupId) {
      return quizzes;
    }
    return quizzes.filter((q) => q.group_id === normalizedFilterGroupId);
  }, [quizzes, normalizedFilterGroupId]);

  const sortedQuizzes = useMemo(() => {
    return [...filteredQuizzes].sort((a, b) => {
      const ad = new Date(a?.updated_at || 0).getTime();
      const bd = new Date(b?.updated_at || 0).getTime();
      return bd - ad;
    });
  }, [filteredQuizzes]);

  const visibleQuizzes = useMemo(() => {
    const q = (query || "").toLowerCase();
    if (!q) return sortedQuizzes;
    return sortedQuizzes.filter((x) =>
      (x.title || "").toLowerCase().includes(q)
    );
  }, [sortedQuizzes, query]);

  // Revisit counts (existing)
  const groupReviewCount = useMemo(() => {
    if (!normalizedFilterGroupId) return 0;
    return visibleQuizzes.reduce(
      (sum, q) => sum + (q?.review_questions?.length ?? 0),
      0
    );
  }, [visibleQuizzes, normalizedFilterGroupId]);

  const allReviewCount = useMemo(() => {
    if (normalizedFilterGroupId) return 0;
    return visibleQuizzes.reduce(
      (sum, q) => sum + (q?.review_questions?.length ?? 0),
      0
    );
  }, [visibleQuizzes, normalizedFilterGroupId]);

  // NEW: All-Questions counts (any question, not just Revisit)
  const groupAllCount = useMemo(() => {
    if (!normalizedFilterGroupId) return 0;
    return visibleQuizzes.reduce((sum, q) => sum + (q?.questions?.length ?? 0), 0);
  }, [visibleQuizzes, normalizedFilterGroupId]);

  const allAllCount = useMemo(() => {
    if (normalizedFilterGroupId) return 0;
    return visibleQuizzes.reduce((sum, q) => sum + (q?.questions?.length ?? 0), 0);
  }, [visibleQuizzes, normalizedFilterGroupId]);


  useEffect(() => {
    dbg("COUNTS", {
      filterGroupId,
      groupReviewCount,
      allReviewCount,
      groupAllCount,
      allAllCount,
      allRevisitScore,
      allAllScore,
      groupRevisitForCurrent: currentGroup ? groupRevisitScores.get(currentGroup.id) : null,
      groupAllForCurrent: currentGroup ? groupAllScores.get(currentGroup.id) : null,
    });
  }, [
    filterGroupId,
    groupReviewCount,
    allReviewCount,
    groupAllCount,
    allAllCount,
    allRevisitScore,
    allAllScore,
    currentGroup,
    groupRevisitScores,
    groupAllScores,
  ]);

  const hasAnyQuizzes = (quizzes?.length ?? 0) > 0;
  const isFirstQuizState = !hasAnyQuizzes;
  const hasVisibleQuizzes = (visibleQuizzes?.length ?? 0) > 0;

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
  if (!hydrated) {
    return <SigningInOverlay />;
  }

  return (
    <div className="min-h-screen text-slate-100 overflow-x-hidden pb-16">
      <header className="sticky top-0 z-40 border-b border-white/5 bg-slate-950/95">
        <div className="max-w-6xl mx-auto flex flex-wrap items-end justify-between gap-4 px-6 py-4 sm:items-center">
          <div className="flex flex-col items-start gap-2 pl-2 sm:flex-row sm:items-center sm:gap-3 sm:pl-0 flex-none">
            <img
              src="/smartquizlogo.png"
              alt="Smart-Quiz logo"
              className="h-9 sm:h-10 w-auto my-1 object-contain drop-shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
              draggable="false"
            />
            <div className="text-left w-full sm:w-auto">
              <p className="text-xs uppercase tracking-[0.2em] text-white/60">Dashboard</p>
              <h1 className="text-2xl font-semibold tracking-tight">Your Quizzes</h1>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 text-sm flex-none">
            {!ready ? (
              <span className="text-white/70">Loading…</span>
            ) : isAnon ? (
              <>
                <span className="text-white/60 hidden sm:inline">Guest</span>
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
                <span className="text-white/70 hidden md:inline max-w-[28ch] truncate">
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

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-0 py-8 space-y-6">
        {/* ---- MOBILE actions ---- */}
        {hasAnyQuizzes && (
          <div className="sm:hidden surface-card p-4 space-y-4">
            <div className="flex flex-row gap-2">
              <button
                onClick={async () => {
                  if (isFirstQuizState) return;
                  const allowed = await ensureCanCreate();
                  if (!allowed) return;

                  // 🔧 Prefer the current filter, otherwise fall back to the default group
                  setGGroupId(noGroupOptionValue);

                  setGenOpen(true);
                }}
                disabled={isFirstQuizState}
                className={`${btnBase} ${btnGreen} flex-1 justify-center text-xs sm:text-sm h-12 px-2 ${isFirstQuizState ? "opacity-50 cursor-not-allowed" : ""
                  }`}
              >
                + Generate quiz with AI
              </button>


              <button
                onClick={createQuiz}
                className={`${btnBase} ${btnGray} flex-1 justify-center text-xs sm:text-sm h-12 px-2`}
                disabled={creating}
              >
                {creating ? "Creating…" : "New empty quiz"}
              </button>
            </div>

            <div className="flex flex-row gap-2">
              <div className="space-y-1 flex-1">
                <label className="text-xs uppercase tracking-wide text-white/60">
                  Filter by group
                </label>
                <select
                  className="w-full h-12 custom-select"
                  value={normalizedFilterGroupId}
                  onChange={(e) => setFilterGroupId(e.target.value)}
                >
                  <option value="">All</option>
                  {orderedGroups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1 flex-1">
                <label className="text-xs uppercase tracking-wide text-white/60">
                  Search
                </label>
                <input
                  className="w-full h-12"
                  placeholder="Search quizzes…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>

              {hasSelected && (
                <div className="flex flex-col gap-2 pt-2">
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
        )}

        {/* ---- DESKTOP/TABLET actions ---- */}
        {hasAnyQuizzes && (
          <div className="hidden sm:flex items-center gap-8 surface-card px-5 py-7 w-full max-w-5xl mx-auto">
            <div className="flex gap-3 flex-none items-center">
              <button
                onClick={async () => {
                  if (isFirstQuizState) return;
                  const allowed = await ensureCanCreate();
                  if (!allowed) return;

                  // 🔧 Sync generator target with current filter (fallback to default)
                  setGGroupId(noGroupOptionValue);

                  setGenOpen(true);
                }}
                disabled={isFirstQuizState}
                className={`${btnBase} ${btnGreen} ${actionH} ${isFirstQuizState ? "opacity-50 cursor-not-allowed" : ""
                  }`}
              >
                + Generate quiz with AI
              </button>
              <button
                onClick={createQuiz}
                className={`${btnBase} ${btnGray} ${actionH}`}
                disabled={creating}
              >
                {creating ? "Creating…" : "New empty quiz"}
              </button>
            </div>

            <div className="flex flex-1 justify-center">
              <div
                className={`flex flex-1 flex-wrap items-start justify-between gap-4 w-full ${hasSelected ? "max-w-[50rem] ml-8 mr-4" : "max-w-[46rem]"
                  }`}
              >
                {hasSelected ? (
                  <>
                    <div className="flex-1 min-w-[260px] max-w-lg">
                      <label
                        htmlFor="desktop-search"
                        className="block text-xs uppercase tracking-wide text-white/60 mb-1"
                      >
                        Search
                      </label>
                      <input
                        id="desktop-search"
                        className="w-full h-12"
                        placeholder="Search quizzes…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      <div className="mt-4 flex items-center gap-4">
                        <div className="w-56">
                          <label
                            htmlFor="desktop-filter"
                            className="block text-xs uppercase tracking-wide text-white/60 mb-1"
                          >
                            Filter by group
                          </label>
                          <select
                            id="desktop-filter"
                            className="w-full h-12 custom-select"
                            value={normalizedFilterGroupId}
                            onChange={(e) => setFilterGroupId(e.target.value)}
                          >
                            <option value="">All</option>
                            {orderedGroups.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="flex items-center gap-2 flex-none self-end">
                          <button
                            onClick={() => setMoveOpen(true)}
                            className={`${btnBase} ${btnGray} ${actionH}`}
                          >
                            Move to group
                          </button>
                          <button
                            onClick={() => setBulkConfirmOpen(true)}
                            className={`${btnBase} ${btnRed} ${actionH}`}
                          >
                            Delete selected
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex-1 min-w-[220px] max-w-sm relative">
                      <label
                        htmlFor="desktop-search"
                        className="absolute left-0 -top-6 text-xs uppercase tracking-wide text-white/60"
                      >
                        Search
                      </label>
                      <input
                        id="desktop-search"
                        className="w-full h-12"
                        placeholder="Search quizzes…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </div>

                    <div className="w-56 flex-none relative">
                      <label
                        htmlFor="desktop-filter"
                        className="absolute left-0 -top-6 text-xs uppercase tracking-wide text-white/60"
                      >
                        Filter by group
                      </label>
                      <select
                        id="desktop-filter"
                        className="w-full h-12 custom-select"
                        value={normalizedFilterGroupId}
                        onChange={(e) => setFilterGroupId(e.target.value)}
                      >
                        <option value="">All</option>
                        {orderedGroups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ----------------------- QUIZ LIST / CAROUSEL ---------------------- */}
        {!hasVisibleQuizzes ? (
          hasAnyQuizzes ? (
            <div className="mt-4 surface-card max-w-3xl mx-auto p-6 text-center text-white/70">
              No quizzes in this group yet.
            </div>
          ) : (
            <>
              {/* Inline “Generate with AI” panel for brand-new users */}
              <section className="mt-4 max-w-3xl mx-auto surface-card p-5 sm:p-6 space-y-4">
                <h2 className="text-xl sm:text-2xl font-semibold mb-2">
                  Generate a quiz with AI
                </h2>
                <p className="text-sm text-white/70 mb-4">
                  Use this form to instantly create your first AI quiz.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="sm:col-span-2">
                    <label
                      className="block text-sm text-white/70 mb-1"
                      htmlFor="inline-gen-title"
                    >
                      Name
                    </label>
                    <input
                      id="inline-gen-title"
                      className="field w-full placeholder:text-slate-500"
                      placeholder="Bash Top 10"
                      value={gTitle}
                      onChange={(e) => setGTitle(e.target.value)}
                      disabled={generating}
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label
                      className="block text-sm text-white/70 mb-1"
                      htmlFor="inline-gen-topic"
                    >
                      Prompt
                    </label>
                    <textarea
                      id="inline-gen-topic"
                      className="field-textarea w-full min-h-[8rem] resize-y placeholder:text-slate-500"
                      placeholder="Create 10 questions that test the 10 most-used Bash commands."
                      value={gTopic}
                      onChange={(e) => setGTopic(e.target.value)}
                      disabled={generating}
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="inline-flex items-center gap-2 text-sm text-white/80">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={gNoRepeat}
                        onChange={(e) => setGNoRepeat(e.target.checked)}
                        disabled={generating}
                      />
                      <span>Do not repeat previous questions</span>
                    </label>
                  </div>

                  <div className="sm:col-span-2">
                    <label
                      className="block text-sm text-white/70 mb-1"
                      htmlFor="inline-gen-file"
                    >
                      Optional document to use as source (PDF / TXT / MD)
                    </label>
                    <div className="w-full sm:w-1/2">
                      <input
                        id="inline-gen-file"
                        type="file"
                        accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
                        className="w-full"
                        onChange={(e) => {
                          setGFile(e.target.files?.[0] ?? null);
                          if (e.target.files?.[0]) setYoutubeUrl("");
                        }}
                        disabled={generating || !!youtubeUrl}
                      />
                    </div>
                    {gFile && (
                      <div className="mt-1 text-xs text-white/60">
                        Selected: {gFile.name}{" "}
                        <button
                          type="button"
                          className="underline"
                          onClick={() => setGFile(null)}
                          disabled={generating}
                        >
                          Clear
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="sm:col-span-2">
                    <label
                      className="block text-sm text-white/70 mb-1"
                      htmlFor="inline-gen-youtube"
                    >
                      Or YouTube Video URL
                    </label>
                    <div className="flex gap-2 items-center">
                      <input
                        id="inline-gen-youtube"
                        className="field flex-1 placeholder:text-slate-500"
                        placeholder="https://www.youtube.com/watch?v=..."
                        value={youtubeUrl}
                        onChange={(e) => {
                          setYoutubeUrl(e.target.value);
                          if (e.target.value) setGFile(null);
                        }}
                        disabled={generating || !!gFile}
                      />
                      {youtubeUrl && (
                        <button
                          type="button"
                          onClick={handleDownloadTranscript}
                          disabled={downloadingTranscript || generating}
                          className="h-10 px-3 rounded-lg bg-white/10 hover:bg-white/20 text-white/90 transition-colors flex items-center justify-center"
                          title="Download Transcript"
                        >
                          {downloadingTranscript ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                          ) : (
                            <Download className="w-5 h-5" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="sm:col-span-2">
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                      <div className="w-full sm:flex-1">
                        <label
                          className="block text-sm text-white/70 mb-1"
                          htmlFor="inline-gen-group"
                        >
                          Add to group
                        </label>
                        <select
                          id="inline-gen-group"
                          className="field w-full h-12"
                          value={gGroupId}
                          onChange={(e) => setGGroupId(e.target.value)}
                          disabled={generating}
                        >
                          <option value={noGroupOptionValue}>{NO_GROUP_LABEL}</option>
                          {selectableGroupOptions.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <button
                        type="button"
                        className={`${btnBase} ${btnGray} h-12 px-6`}
                        onClick={() => {
                          setGNewName("");
                          setGNewOpen(true);
                        }}
                        disabled={generating}
                      >
                        New group +
                      </button>

                      <div className="w-full sm:w-28">
                        <label
                          className="block text-sm text-white/70 mb-1"
                          htmlFor="inline-gen-count"
                        >
                          # of questions
                        </label>
                        <input
                          id="inline-gen-count"
                          className="field w-full h-12 text-center"
                          type="number"
                          min={1}
                          max={30}
                          value={gCount}
                          onChange={(e) =>
                            setGCount(Number(e.target.value) || 10)
                          }
                          disabled={generating}
                        />
                      </div>

                      <button
                        className={`${btnBase} ${btnGreen} h-12 px-6 sm:ml-auto`}
                        onClick={generateQuiz}
                        disabled={generating}
                      >
                        {generating ? "Generating…" : "Generate"}
                      </button>
                    </div>
                  </div>
                </div>

              </section>
              <div className="mt-4 flex flex-col sm:flex-row sm:items-center gap-3 max-w-3xl mx-auto px-5 sm:px-0">
                <p className="text-white/70 text-sm">
                  Want to create a quiz from scratch without AI?
                </p>
                <button
                  className={`${btnBase} ${btnGray} w-full sm:w-auto`}
                  onClick={createQuiz}
                  disabled={creating}
                >
                  {creating ? "Creating…" : "New Blank Quiz"}
                </button>
              </div>
            </>
          )
        ) : (
          <>
            {/* --- MOBILE vertical list --- */}
            <div className="sm:hidden">
              <div className="relative">
                <div
                  className="w-full pt-2 max-h-[72vh] overflow-y-auto overscroll-auto"
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
                          className="w-full max-w-[620px] surface-panel p-6 flex flex-col overflow-visible min-h-[380px] h-auto"
                        >
                          {/* Top: meta + preview */}
                          <div className="flex-1 grid grid-cols-1 gap-3 min-h-0 overflow-visible">
                            {/* LEFT: title + meta */}
                            <div className="min-w-0">
                              <div className="flex items-start gap-3 pl-1">
                                <input
                                  type="checkbox"
                                  className="h-5 w-5 accent-emerald-500 mt-1 shrink-0"
                                  checked={selectedIds.has(q.id)}
                                  onChange={() => toggleSelected(q.id)}
                                  aria-label={`Select ${q.title || "Untitled Quiz"}`}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div
                                        className="text-xl font-semibold leading-tight break-words"
                                        title={q.title || "Untitled Quiz"}
                                      >
                                        {q.title || "Untitled Quiz"}
                                      </div>

                                      <div className="mt-2 text-xs text-white/70 space-y-0.5">
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

                                    <div className="flex items-center gap-2 shrink-0">
                                      <button
                                        onClick={() => toggleMenu(q.id)}
                                        className={`${btnBase} ${btnGray} h-11 w-11 sm:h-12 sm:w-12 p-0 flex items-center justify-center shrink-0 ${expandedMenuId === q.id ? "bg-white/20" : ""}`}
                                        aria-label="Toggle options"
                                        title="More options"
                                      >
                                        <PanelRight className="h-5 w-5 sm:h-6 sm:w-6" />
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Collapsible Menu */}
                            <div
                              className={`overflow-hidden transition-all duration-300 ease-in-out ${expandedMenuId === q.id ? "max-h-40 opacity-100 mb-3" : "max-h-0 opacity-0"}`}
                            >
                              <div className="bg-white/5 rounded-xl p-2 space-y-1">
                                <button
                                  onClick={() => handleShareQuiz(q.id, q.title || "Untitled Quiz")}
                                  className="w-full text-left px-4 py-3 rounded-lg hover:bg-white/10 text-sm font-medium flex items-center gap-3 transition-colors"
                                >
                                  <div className="w-5 flex justify-center shrink-0">
                                    <Mail className="h-4 w-4 text-white/70" />
                                  </div>
                                  Copy link to share
                                </button>
                                <Link
                                  to={`/scores/${q.id}`}
                                  className="w-full text-left px-4 py-3 rounded-lg hover:bg-white/10 text-sm font-medium flex items-center gap-3 transition-colors"
                                >
                                  <div className="w-5 flex justify-center shrink-0">
                                    <img src="/icons/scoreboard.svg" alt="" className="h-[18px] w-[18px] opacity-70" />
                                  </div>
                                  View scoreboard
                                </Link>
                              </div>
                            </div>

                            {/* RIGHT: Questions preview */}
                            <div className="relative bg-white/5 border border-white/5 rounded-2xl p-3 overflow-hidden">
                              <ol className="text-[13px] leading-5 list-decimal pl-5 pr-3 pb-7 space-y-1.5 max-h-[160px] overflow-hidden">
                                {(Array.isArray(q.questions) ? q.questions : []).map(
                                  (it, idx) => {
                                    const p = (it?.prompt || "").toString().trim();
                                    if (!p) return null;
                                    return (
                                      <li key={idx} className="break-words">
                                        {p}
                                      </li>
                                    );
                                  }
                                )}
                              </ol>
                              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-slate-950/70 via-slate-950/25 to-transparent" />
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
                              className={`${btnBase} ${btnGray} h-11 p-0 flex items-center justify-center ${reviewDisabled ? "opacity-50 cursor-not-allowed" : ""
                                }`}
                              aria-label={
                                reviewDisabled ? "No Revisit questions yet" : "Practice Revisit"
                              }
                              title={
                                reviewDisabled ? "No Revisit questions yet" : "Practice Revisit"
                              }
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
            <div className="relative hidden sm:block overflow-visible">
              {canLeft && (
                <button
                  type="button"
                  onClick={scrollLeft}
                  className="absolute -left-4 top-1/2 -translate-y-1/2 z-10 bg-white/10 hover:bg-white/20 rounded-full p-3 shadow-lg shadow-black/40"
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
                  className="absolute -right-4 top-1/2 -translate-y-1/2 z-10 bg-white/10 hover:bg-white/20 rounded-full p-3 shadow-lg shadow-black/40"
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
                        className="sm:snap-start shrink-0 w-[560px] max-w-[600px]
                                   surface-card px-6 py-5
                                   h-[470px] flex flex-col overflow-visible"
                      >
                        {/* Top content */}
                        <div className="flex-1 grid grid-cols-2 gap-4 min-h-0 overflow-hidden">
                          {/* LEFT: title + meta */}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start gap-3 pl-1">
                              <input
                                type="checkbox"
                                className="h-6 w-6 accent-emerald-500 mt-1 shrink-0"
                                checked={selectedIds.has(q.id)}
                                onChange={() => toggleSelected(q.id)}
                                aria-label={`Select ${q.title || "Untitled Quiz"}`}
                              />
                              <div className="min-w-0">
                                <div
                                  className="text-2xl font-semibold leading-tight break-words line-clamp-2 h-[3.8rem] overflow-hidden"
                                  title={q.title || "Untitled Quiz"}
                                >
                                  {q.title || "Untitled Quiz"}
                                </div>

                                <div className="mt-3 text-sm text-white/70 space-y-1">
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
                                <div className="mt-5 flex items-center gap-3">
                                  <button
                                    onClick={() => toggleMenu(q.id)}
                                    className={`${btnBase} ${btnGray} h-12 w-12 sm:h-14 sm:w-14 p-0 flex items-center justify-center ${expandedMenuId === q.id ? "bg-white/20" : ""}`}
                                    aria-label="Toggle options"
                                    title="More options"
                                  >
                                    <PanelRight className="h-5 w-5 sm:h-6 sm:w-6" />
                                  </button>
                                </div>

                                {/* Collapsible Menu */}
                                <div
                                  className={`overflow-hidden transition-all duration-300 ease-in-out ${expandedMenuId === q.id ? "max-h-40 opacity-100 mt-3" : "max-h-0 opacity-0"}`}
                                >
                                  <div className="bg-white/5 rounded-xl p-2 space-y-1">
                                    <button
                                      onClick={() => handleShareQuiz(q.id, q.title || "Untitled Quiz")}
                                      className="w-full text-left px-4 py-3 rounded-lg hover:bg-white/10 text-sm font-medium flex items-center gap-3 transition-colors"
                                    >
                                      <div className="w-5 flex justify-center shrink-0">
                                        <Mail className="h-4 w-4 text-white/70" />
                                      </div>
                                      Copy link to share
                                    </button>
                                    <Link
                                      to={`/scores/${q.id}`}
                                      className="w-full text-left px-4 py-3 rounded-lg hover:bg-white/10 text-sm font-medium flex items-center gap-3 transition-colors"
                                    >
                                      <div className="w-5 flex justify-center shrink-0">
                                        <img src="/icons/scoreboard.svg" alt="" className="h-[18px] w-[18px] opacity-70" />
                                      </div>
                                      View scoreboard
                                    </Link>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* RIGHT: Questions preview */}
                          <div className="relative bg-white/5 border border-white/5 rounded-2xl p-3 overflow-hidden">
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
                            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-slate-950/70 via-slate-950/25 to-transparent" />
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
                            to={reviewDisabled ? "#" : `/play/${q.id}?mode=review`}
                            onClick={(e) => {
                              if (reviewDisabled) e.preventDefault();
                            }}
                            className={`${btnBase} ${btnGray} h-12 sm:h-14 p-0 flex items-center justify-center ${reviewDisabled ? "opacity-50 cursor-not-allowed" : ""
                              }`}
                            aria-label={
                              reviewDisabled ? "No Revisit questions yet" : "Practice Revisit"
                            }
                            title={
                              reviewDisabled ? "No Revisit questions yet" : "Practice Revisit"
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


        {dbg("FOOTER check", { filterGroupId, isEmpty: !normalizedFilterGroupId, hasCurrent: !!currentGroup })}

        {/* ---------------- Footer actions + “Last score” ------------------- */}
        {(() => {
          const hasAnyQuizzes = (quizzes?.length ?? 0) > 0;
          if (!hasAnyQuizzes) return null;

          const isAll = !normalizedFilterGroupId;
          const activeGroup = currentGroup ?? null;
          const heading = isAll
            ? "All Quizzes"
            : activeGroup
              ? `${activeGroup.name} Quizzes`
              : "Group";

          const lastRevisitScore = isAll
            ? typeof allRevisitScore === "number"
              ? allRevisitScore
              : null
            : activeGroup
              ? groupRevisitScores.get(activeGroup.id) ?? null
              : null;

          const lastAllScore = isAll
            ? typeof allAllScore === "number"
              ? allAllScore
              : null
            : activeGroup
              ? groupAllScores.get(activeGroup.id) ?? null
              : null;

          const reviewCount = isAll ? allReviewCount : groupReviewCount;
          const allCount = isAll ? allAllCount : groupAllCount;

          const reviewLink = isAll
            ? "/play/all?mode=review"
            : activeGroup
              ? `/play/group/${activeGroup.id}?mode=review`
              : "#";
          const allLink = isAll
            ? "/play/all?mode=all"
            : activeGroup
              ? `/play/group/${activeGroup.id}?mode=all`
              : "#";

          return (
            <div className="mt-8 flex justify-center">
              <div className="w-full sm:w-auto">
                <div className="w-full sm:w-auto surface-card p-5 sm:p-6">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between md:flex-nowrap gap-4">
                    {/* LEFT: context + last scores */}
                    <div className="text-base text-white/70 space-y-2 text-center md:text-left">
                      <div>
                        <span className="font-semibold text-white text-xl sm:text-2xl tracking-tight">
                          {heading}
                        </span>
                      </div>

                      {/* Revisit last score */}
                      <div className="text-sm sm:text-base">
                        <span className="text-white/60">Revisit last score:</span>{" "}
                        {typeof lastRevisitScore === "number" ? (
                          <span
                            className={
                              lastRevisitScore >= 90
                                ? "text-green-400 font-semibold"
                                : "text-white"
                            }
                          >
                            {lastRevisitScore}%
                          </span>
                        ) : (
                          "—"
                        )}
                      </div>

                      {/* All-Questions last score */}
                      <div className="text-sm sm:text-base">
                        <span className="text-white/60">All-questions last score:</span>{" "}
                        {typeof lastAllScore === "number" ? (
                          <span
                            className={
                              lastAllScore >= 90
                                ? "text-green-400 font-semibold"
                                : "text-white"
                            }
                          >
                            {lastAllScore}%
                          </span>
                        ) : (
                          "—"
                        )}
                      </div>

                    </div>

                    {/* RIGHT: actions */}
                    <div className="flex flex-col gap-3 w-full items-center md:items-start md:w-auto md:flex-row md:flex-wrap">
                      <Link
                        to={reviewCount > 0 ? reviewLink : "#"}
                        onClick={(e) => {
                          if (reviewCount === 0) e.preventDefault();
                        }}
                        className={`${btnBase} ${btnGray} inline-flex items-center justify-center w-48 sm:w-auto min-h-[3.5rem] sm:min-h-[3.75rem] px-5 rounded-2xl ${reviewCount === 0 ? "opacity-50 cursor-not-allowed" : ""
                          }`}
                        title={
                          reviewCount === 0
                            ? "No Revisit questions yet"
                            : isAll
                              ? "Play Revisit Questions (All quizzes)"
                              : `Play "${activeGroup?.name ?? ""}" Revisit Questions`
                        }
                        aria-label={
                          isAll
                            ? "Play Revisit Questions (All)"
                            : `Play ${activeGroup?.name ?? "group"} Revisit Questions`
                        }
                      >
                        <History className="h-7 w-7 sm:h-8 sm:w-8 shrink-0" />
                      </Link>

                      <Link
                        to={allCount > 0 ? allLink : "#"}
                        onClick={(e) => {
                          if (allCount === 0) e.preventDefault();
                        }}
                        className={`${btnBase} ${btnGreen} inline-flex items-center justify-center w-48 sm:w-auto min-h-[3.5rem] sm:min-h-[3.75rem] px-5 rounded-2xl ${allCount === 0 ? "opacity-50 cursor-not-allowed" : ""
                          }`}
                        title={
                          allCount === 0
                            ? "No questions yet"
                            : isAll
                              ? "Play All Questions (All quizzes)"
                              : `Play "${activeGroup?.name ?? ""}" All Questions`
                        }
                        aria-label={
                          isAll
                            ? "Play All Questions (All)"
                            : `Play ${activeGroup?.name ?? "group"} All Questions`
                        }
                      >
                        <Play className="h-7 w-7 sm:h-8 sm:w-8 shrink-0" />
                      </Link>

                      {activeGroup && (
                        <>
                          <button
                            onClick={openEditGroup}
                            className={`${btnBase} ${btnGray} inline-flex items-center justify-center w-48 sm:w-auto min-h-[3.5rem] sm:min-h-[3.75rem] px-5 rounded-2xl`}
                            title="Edit this group’s name"
                            aria-label="Edit group name"
                          >
                            <SquarePen className="h-8 w-8" strokeWidth={2} />
                          </button>

                          <button
                            onClick={() => setDeleteGroupOpen(true)}
                            className={`${btnBase} ${btnRed} inline-flex items-center justify-center w-48 sm:w-auto min-h-[3.5rem] sm:min-h-[3.75rem] px-5 rounded-2xl`}
                            title={`Delete "${activeGroup.name}" and all its quizzes`}
                            aria-label={`Delete ${activeGroup.name} group`}
                          >
                            <Trash2 className="h-8 w-8" strokeWidth={2} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
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
            className="w-full max-w-md surface-card p-6 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2">Delete quiz?</h2>
            <p className="text-white/70 mb-6">
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
                className={`${btnBase} ${btnRed}`}
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
            className="w-full max-w-md surface-card p-6 max-h-[85vh] overflow-y-auto"
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
            <p className="text-white/70 text-sm">
              Feedback? -{" "}
              <span className="text-white/70 text-sm">support@smart-quiz.app</span>
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
            className="w-full max-w-md surface-card p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-3">Delete account?</h2>
            <p className="text-white/70 mb-6 text-sm">
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

      {shareCopiedPulse && (
        <div className="fixed inset-0 z-[115] pointer-events-none flex items-center justify-center">
          <div className="w-32 h-32 sm:w-36 sm:h-36 rounded-full bg-emerald-400 flex items-center justify-center shadow-2xl animate-pulse">
            <span className="text-slate-900 font-semibold text-lg sm:text-xl">
              Link copied!
            </span>
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
            className="w-full max-w-md surface-card p-6 max-h-[85vh] overflow-y-auto"
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

            <p className="text-white/70 mb-4 text-sm">
              Creating an account upgrades your current guest session so your
              quizzes stay with you.
            </p>

            <label
              className="block text-sm text-white/70 mb-1"
              htmlFor="auth-email"
            >
              Email
            </label>
            <input
              id="auth-email"
              className="field w-full mb-3"
              type="email"
              placeholder="you@example.com"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              autoFocus
            />

            <label
              className="block text-sm text-white/70 mb-1"
              htmlFor="auth-pass"
            >
              Password
            </label>
            <input
              id="auth-pass"
              className="field w-full mb-4"
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
                onClick={() => oauthOrLink("google")}
                className="h-12 w-12 rounded-full bg-white border border-gray-300 shadow flex items-center justify-center hover:shadow-md active:scale-95 transition"
                aria-label="Continue with Google"
                title="Continue with Google"
                disabled={authBusy}
              >
                <svg width="24" height="24" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.6 32.4 29.2 35 24 35c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C33.8 5.1 29.2 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21c10.5 0 20-7.6 20-21 0-1.3-.1-2.7-.4-3.5z" />
                  <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.5 16 19 13 24 13c3 0 5.8 1.1 7.9 3l5.7-5.7C33.8 5.1 29.2 3 24 3 16 3 8.9 7.6 6.3 14.7z" />
                  <path fill="#4CAF50" d="M24 45c5.1 0 9.8-1.9 13.3-5.1l-6.1-5c-2 1.5-4.6 2.4-7.2 2.4-5.2 0-9.6-3.5-11.2-8.3L6.2 33.9C8.8 41 16 45 24 45z" />
                  <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1.1 3.1-3.6 5.6-6.6 6.9l6.1 5C37.8 37.9 41 31.9 41 24c0-1.3-.1-2.7-.4-3.5z" />
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
            className="w-full max-w-xl surface-card p-6 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-4">Generate a quiz</h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-5 sm:gap-y-6 gap-x-4">
              <div className="sm:col-span-2">
                <label className="block text-sm text-white/70 mb-1" htmlFor="gen-title">
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
                <label className="block text-sm text-white/70 mb-1" htmlFor="gen-topic">
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
                <label className="inline-flex items-center gap-2 text-sm text-white/80">
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
                <label className="block text-sm text-white/70 mb-1" htmlFor="gen-file">
                  Optional document to use as source (PDF / TXT / MD)
                </label>
                <input
                  id="gen-file"
                  type="file"
                  accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
                  className="w-full"
                  onChange={(e) => {
                    setGFile(e.target.files?.[0] ?? null);
                    if (e.target.files?.[0]) setYoutubeUrl("");
                  }}
                  disabled={generating || !!youtubeUrl}
                />
                {gFile && (
                  <div className="mt-1 text-xs text-white/70">
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

              <div className="sm:col-span-2">
                <label
                  className="block text-sm text-white/70 mb-1"
                  htmlFor="gen-youtube"
                >
                  Or YouTube Video URL
                </label>
                <div className="flex gap-2 items-center">
                  <input
                    id="gen-youtube"
                    className="field flex-1 placeholder:text-gray-400"
                    placeholder="https://www.youtube.com/watch?v=..."
                    value={youtubeUrl}
                    onChange={(e) => {
                      setYoutubeUrl(e.target.value);
                      if (e.target.value) setGFile(null);
                    }}
                    disabled={generating || !!gFile}
                  />
                  {youtubeUrl && (
                    <button
                      type="button"
                      onClick={handleDownloadTranscript}
                      disabled={downloadingTranscript || generating}
                      className="h-10 px-3 rounded-lg bg-white/10 hover:bg-white/20 text-white/90 transition-colors flex items-center justify-center"
                      title="Download Transcript"
                    >
                      {downloadingTranscript ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <Download className="w-5 h-5" />
                      )}
                    </button>
                  )}
                </div>
              </div>

              <div className="sm:col-span-2">
                <div className="flex flex-col sm:flex-row sm:items-end gap-2">
                  <div className="w-full sm:flex-1">
                    <label
                      className="block text-sm text-white/70 mb-1"
                      htmlFor="gen-group"
                    >
                      Add to group
                    </label>
                    <select
                      id="gen-group"
                      className="w-full min-w-[180px] h-12 custom-select"
                      value={gGroupId}
                      onChange={(e) => setGGroupId(e.target.value)}
                    >
                      <option value={noGroupOptionValue}>{NO_GROUP_LABEL}</option>
                      {selectableGroupOptions.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <button
                    type="button"
                    className={`${btnBase} ${btnGray} h-12 px-6 whitespace-nowrap`}
                    onClick={() => {
                      setGNewName("");
                      setGNewOpen(true);
                    }}
                  >
                    New group +
                  </button>

                  <div className="w-full sm:w-24">
                    <label
                      className="block text-sm text-white/70 mb-1"
                      htmlFor="gen-count"
                    >
                      # of questions
                    </label>
                    <input
                      id="gen-count"
                      className="field w-full h-12 text-center"
                      type="number"
                      min={1}
                      max={30}
                      value={gCount}
                      onChange={(e) => setGCount(Number(e.target.value))}
                    />
                  </div>
                </div>
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
            className="w-full max-w-md surface-card p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-4">Create new group</h2>
            <input
              className="w-full"
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
            className="w-full max-w-md surface-card p-6 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2">
              Delete selected quizzes?
            </h2>
            <p className="text-white/70 mb-4">
              You have selected:
              <span className="block mt-1 font-semibold break-words">
                {Array.from(selectedIds).length
                  ? Array.from(selectedIds)
                    .map((id) => quizzes.find((q) => q.id === id)?.title || "Untitled Quiz")
                    .join(", ")
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
            className="w-full max-w-md surface-card p-6 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-4">Move selected to group</h2>
            <p className="text-white/70 mb-4">
              Selected: <span className="font-semibold">{selectedIds.size}</span>{" "}
              {selectedIds.size === 1 ? "quiz" : "quizzes"}
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-white/70 mb-1">
                  Choose existing group
                </label>
                <select
                  className="w-full"
                  value={moveGroupId}
                  onChange={(e) => setMoveGroupId(e.target.value)}
                >
                  <option value="">Select…</option>
                  {orderedGroups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-white/70 mb-1">
                  Or create a new group
                </label>
                <input
                  className="w-full"
                  placeholder="New group name (optional)"
                  value={moveNewName}
                  onChange={(e) => setMoveNewName(e.target.value)}
                />
                <p className="text-xs text-white/60 mt-1">
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
            className="w-full max-w-md surface-card p-6 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2">Delete group?</h2>
            <p className="text-white/70 mb-6">
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
            className="w-full max-w-md surface-card p-6 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-4">Rename group</h2>
            <input
              className="w-full"
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
            className="w-full max-w-md surface-card p-6 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2">Delete empty group?</h2>
            <p className="text-white/70 mb-6">
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
