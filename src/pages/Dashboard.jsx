// src/pages/Dashboard.jsx
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";

import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/build/pdf.mjs";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url"; // <-- Vite will emit an asset URL
GlobalWorkerOptions.workerSrc = workerSrc;

// Sentinel used to represent "No group" in selects/filters
const NO_GROUP = "__none__";

export default function Dashboard() {
  // auth
  const { user, ready, signout, signupOrLink, signin } = useAuth();

  // --- UI button helpers (consistent across the app) ---
  const pressAnim = "transition-transform duration-100 active:scale-95";
  const btnBase =
    "px-3 py-2 rounded disabled:opacity-60 disabled:cursor-not-allowed";
  const btnGray = `bg-gray-700 hover:bg-gray-600 ${pressAnim}`;
  const btnGreen = `bg-emerald-500 hover:bg-emerald-600 font-semibold ${pressAnim}`;
  const btnRed = `bg-red-600 hover:bg-red-700 ${pressAnim}`;
  const btnRedSoft = `bg-red-500 hover:bg-red-600 ${pressAnim}`;
  const actionH = "h-12"; // ensures equal height on mobile where needed

  // Robust anonymous detector that covers multiple SDK shapes
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
    if (!import.meta.env.DEV) return; // only log in dev
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

  const nav = useNavigate();

  const [quizzes, setQuizzes] = useState([]);
  const [scoresByQuiz, setScoresByQuiz] = useState({}); // { [quizId]: percent }

  // auth modal
  const [authOpen, setAuthOpen] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPass, setAuthPass] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState("");

  // Upgrade current anonymous user -> email/password (keeps same user.id & data)
  async function handleCreateAccount() {
    try {
      setAuthBusy(true);
      const email = (authEmail || "").trim();
      const password = authPass || "";
      if (!email || !password) {
        alert("Please enter email and password.");
        return;
      }

      await signupOrLink(email, password); // <-- kicks off adoption flow
      setAuthMessage("Check your email to confirm your account, then return here.");
    } catch (err) {
      console.error(err);
      alert(err?.message || "Failed to start signup.");
    } finally {
      setAuthBusy(false);
    }
  }

  // (Optional) Sign in to existing account (replaces the guest session)
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

  // NEW: sign out, then open the auth modal on top of the dashboard
  async function handleSignOut() {
    await signout();
    setAuthMessage(
      "You’re signed out. Sign in or create an account to save your progress."
    );
    setAuthOpen(true);
  }

  // guest trial state (limit = 2)
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

  // single delete
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [target, setTarget] = useState(null); // { id, title, group_id }
  const [deleting, setDeleting] = useState(false);

  // AI generate
  const [genOpen, setGenOpen] = useState(false);

  // leave these empty so the UI shows placeholders instead of hard text
  const [gTitle, setGTitle] = useState("");
  const [gTopic, setGTopic] = useState("");
  const [gCount, setGCount] = useState(10); // keep 10 prefilled
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [gGroupId, setGGroupId] = useState(""); // "" => No group
  const [gFile, setGFile] = useState(null);
  const [gNoRepeat, setGNoRepeat] = useState(true);

  // create group inside AI modal
  const [gNewOpen, setGNewOpen] = useState(false);
  const [gNewName, setGNewName] = useState("");
  const [gCreatingGroup, setGCreatingGroup] = useState(false);

  // groups + filter
  const [groups, setGroups] = useState([]); // { id, name }[]
  const [filterGroupId, setFilterGroupId] = useState(""); // ""=all, NO_GROUP="__none__"=no group
  const scoreSort = "asc"; // keep behavior: lowest scores first by default
  const currentGroup = groups.find((g) => g.id === filterGroupId) || null;

  // Edit group name modal
  const [editGroupOpen, setEditGroupOpen] = useState(false);
  const [editGroupName, setEditGroupName] = useState("");
  const [savingGroupName, setSavingGroupName] = useState(false);

  // cleanup queue for empty groups (supports multiple prompts)
  const [cleanupQueue, setCleanupQueue] = useState([]); // string[] of group ids
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupGroup, setCleanupGroup] = useState(null); // { id, name }
  const [cleaning, setCleaning] = useState(false);

  // multi-select
  const [selectedIds, setSelectedIds] = useState(new Set());
  const hasSelected = selectedIds.size > 0;

  // bulk delete
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  // bulk move
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveGroupId, setMoveGroupId] = useState(""); // target existing group id
  const [moveNewName, setMoveNewName] = useState(""); // create new group name
  const [moving, setMoving] = useState(false);

  // --- delete-current-group (when a specific group is filtered)
  const [deleteGroupOpen, setDeleteGroupOpen] = useState(false);
  const [deletingGroup, setDeletingGroup] = useState(false);

  // ---------- data loading ----------
  async function load() {
    // 1) Load quizzes (like before)
    let q = supabase
      .from("quizzes")
      .select("id, title, questions, updated_at, group_id")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false });

    if (filterGroupId === "") {
      // all groups
    } else if (filterGroupId === NO_GROUP) {
      q = q.is("group_id", null);
    } else {
      q = q.eq("group_id", filterGroupId);
    }

    const { data, error } = await q;
    if (error) {
      setQuizzes([]);
      setScoresByQuiz({});
      return;
    }

    const list = data ?? [];
    setQuizzes(list);

    // 2) Pull last scores for just these quizzes
    const ids = list.map((x) => x.id);
    if (ids.length === 0) {
      setScoresByQuiz({});
      return;
    }

    const { data: scores, error: sErr } = await supabase
      .from("quiz_scores")
      .select("quiz_id, last_score")
      .in("quiz_id", ids)
      .eq("user_id", user.id);

    if (sErr || !scores) {
      setScoresByQuiz({});
      return;
    }

    const map = {};
    for (const row of scores) {
      map[row.quiz_id] = row.last_score; // integer 0-100
    }
    setScoresByQuiz(map);
  }
  useEffect(() => {
    if (ready && user) load();
  }, [ready, user?.id, filterGroupId]);

  useEffect(() => {
    if (!user?.id) return;
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from("groups")
        .select("id, name")
        .eq("user_id", user.id)
        .order("name", { ascending: true });
      if (!alive) return;
      setGroups(data ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [user?.id]);

  // compute “free quizzes left” for anonymous users (limit = 2)
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      if (!isAnon) {
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
  }, [isAnon, user?.id, quizzes.length]);

  // ---------- helpers: selection ----------
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

  // ---------- helpers: empty-group queue ----------
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
    return g; // { id, name }
  }

  async function runNextCleanupIfIdle() {
    if (cleanupOpen) return; // modal already showing
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
    if (!cleanupOpen) {
      setTimeout(runNextCleanupIfIdle, 0);
    }
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

  // ---------- create / delete (single) ----------
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

  // Extract text from user file (PDF/TXT/MD)
  async function extractTextFromFile(file) {
    if (
      file.type?.startsWith("text/") ||
      file.name.toLowerCase().endsWith(".txt") ||
      file.name.toLowerCase().endsWith(".md")
    ) {
      const asText = await file.text();
      return asText;
    }

    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
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

  // Quick preflight: block guests at/over the limit before doing any work
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

  // ---------- AI generate ----------
  async function generateQuiz() {
    try {
      if (generating) return;

      // Preflight: block instantly if at limit
      const allowed = await ensureCanCreate();
      if (!allowed) return;

      setGenerating(true);

      const { data: sessionRes } = await supabase.auth.getSession();
      const jwt = sessionRes?.session?.access_token;
      const count = Math.max(1, Math.min(Number(gCount) || 10, 30));

      // Which group should we consider for no-repeat?
      const targetGroupIdForNoRepeat =
        (gGroupId && gGroupId !== "") ||
        (filterGroupId && filterGroupId !== NO_GROUP)
          ? (gGroupId || (filterGroupId !== NO_GROUP ? filterGroupId : ""))
          : "";

      // 1) Optional: index uploaded file (RAG)
      let file_id = null;
      if (gFile) {
        let rawDoc = "";
        try {
          rawDoc = await extractTextFromFile(gFile);
        } catch (e) {
          alert(`Couldn't read file "${gFile.name}". Please try a different file.\n\n${e}`);
          setGenerating(false);
          return;
        }

        const LIMIT = 500_000; // ~500k chars
        if (rawDoc.length > LIMIT) rawDoc = rawDoc.slice(0, LIMIT);

        const idxRes = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/index-source`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
            },
            body: JSON.stringify({
              text: rawDoc,
              file_name: gFile.name,
            }),
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

      // 2) Build an avoid list from this group's existing questions (if enabled)
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
          // de-dup and cap to keep payload small
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

      // 3) Generate quiz (works even when file_id is null)
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
            // NEW: no-repeat hints for the Edge Function
            no_repeat: !!gNoRepeat,
            avoid_prompts, // array of prior prompts in this group
          }),
        }
      );

      let raw = "";
      try {
        raw = await res.text();
      } catch {}

      if (!res.ok) {
        if (res.status === 403) {
          openSignupModal(
            "Free trial limit reached. Create an account to make more quizzes."
          );
        } else {
          alert(`Failed to generate quiz (${res.status}):\n${raw || "Unknown error"}`);
        }
        setGenerating(false);
        return;
      }

      // Success — close modal, reset file, refresh list
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

  // ---------- BULK: delete ----------
  async function doBulkDelete() {
    if (selectedIds.size === 0) return;
    setBulkDeleting(true);
    try {
      const ids = Array.from(selectedIds);

      // Which groups might become empty after delete?
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

  // ---------- BULK: move ----------
  async function doBulkMove() {
    if (selectedIds.size === 0) return;
    setMoving(true);
    try {
      const ids = Array.from(selectedIds);

      // previous groups (for cleanup prompts later)
      const { data: beforeRows, error: beforeErr } = await supabase
        .from("quizzes")
        .select("id, group_id")
        .in("id", ids)
        .eq("user_id", user.id);
      if (beforeErr) throw beforeErr;
      const prevGroupIds = Array.from(
        new Set((beforeRows || []).map((r) => r.group_id).filter(Boolean))
      );

      // target group
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

  // Delete the currently filtered group (and its quizzes)
  async function deleteCurrentGroupNow() {
    if (!currentGroup?.id) return;
    try {
      setDeletingGroup(true);

      // delete quizzes in the group first
      const { error: qErr } = await supabase
        .from("quizzes")
        .delete()
        .eq("user_id", user.id)
        .eq("group_id", currentGroup.id);
      if (qErr) throw qErr;

      // then delete the group
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

  // Edit / save current group's name
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
      // update local state
      setGroups((gs) =>
        gs
          .map((g) => (g.id === currentGroup.id ? { ...g, name: data.name } : g))
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

  // ------- Memoized sorted list by score (no-score items at bottom) -------
  const sortedQuizzes = useMemo(() => {
    return [...quizzes].sort((a, b) => {
      const av = scoresByQuiz[a.id];
      const bv = scoresByQuiz[b.id];
      const aVal =
        av == null ? (scoreSort === "asc" ? Infinity : -Infinity) : av;
      const bVal =
        bv == null ? (scoreSort === "asc" ? Infinity : -Infinity) : bv;
      return scoreSort === "asc" ? aVal - bVal : bVal - aVal;
    });
  }, [quizzes, scoresByQuiz]);

  const selectedTitles = useMemo(() => {
  if (!selectedIds.size) return [];
  const byId = new Map(quizzes.map(q => [q.id, q]));
  return Array.from(selectedIds).map(id => {
    const t = byId.get(id)?.title;
    return (t && t.trim()) ? t : "Untitled Quiz";
  });
}, [selectedIds, quizzes]);


  // ---------- UI ----------
  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="flex items-center justify-between p-3 sm:p-4 border-b border-gray-800">
        <h1 className="text-xl font-bold">Your Quizzes</h1>

        <div className="flex items-center gap-3 text-sm">
          {!ready ? (
            <span className="text-gray-400">Loading…</span>
          ) : isAnon ? (
            <>
              <span className="text-gray-300">Guest</span>
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
              <span className="text-gray-300 hidden sm:inline">
                {user.email}
              </span>
              <button onClick={handleSignOut} className={`${btnBase} ${btnGray}`}>
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
      </header>

      <main className="max-w-3xl mx-auto p-6">
        {/* TOOLBAR (responsive: stacks on mobile) */}
        <div className="mb-6 flex flex-col sm:flex-row sm:flex-nowrap items-stretch sm:items-center gap-3">
          {/* Left: primary actions (equal height on mobile) */}
          <div className="flex items-stretch gap-3 shrink-0 w-full sm:w-auto">
            <button
              onClick={async () => {
                if (filterGroupId && filterGroupId !== NO_GROUP)
                  setGGroupId(filterGroupId);
                else setGGroupId("");

                const allowed = await ensureCanCreate();
                if (!allowed) return;

                setGenOpen(true);
              }}
              className={`w-full sm:w-auto ${btnBase} ${btnGreen} ${actionH}`}
            >
              + Generate Quiz with AI
            </button>
            <button
              onClick={createQuiz}
              className={`w-full sm:w-auto ${btnBase} ${btnGray} ${actionH}`}
              disabled={creating}
            >
              {creating ? "Creating…" : "New empty quiz"}
            </button>
          </div>

          {/* Right: filters stacked, with bulk actions underneath */}
          <div className="sm:ml-auto w-full sm:w-auto flex flex-col items-stretch sm:items-end gap-3 min-w-0">
            {/* Filter by group */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <label className="text-sm text-gray-300 shrink-0">
                Filter by group:
              </label>
              <select
                className="w-full sm:w-48 shrink-0 p-2 rounded bg-gray-800 text-white border border-gray-700"
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

            {/* Bulk actions appear neatly UNDER the filters */}
            {hasSelected && (
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
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
        </div>

        {/* LIST */}
        {sortedQuizzes.length === 0 ? (
          <div className="text-gray-400">
            No quizzes yet. Create one or generate with AI.
          </div>
        ) : (
          <ul className="space-y-3">
            {sortedQuizzes.map((q) => (
              <li
                key={q.id}
                className="bg-gray-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
              >
                {/* LEFT: checkbox + title/meta */}
                <div className="flex items-start sm:items-center gap-3">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-emerald-500 mt-1 sm:mt-0"
                    checked={selectedIds.has(q.id)}
                    onChange={() => toggleSelected(q.id)}
                    aria-label={`Select ${q.title || "Untitled Quiz"}`}
                  />
                  <div>
                    <div className="text-lg font-semibold">
                      {q.title || "Untitled Quiz"}
                    </div>
                    <div className="text-sm text-gray-400">
                      {q.questions?.length ?? 0} questions
                    </div>
                    <div className="text-sm text-gray-400">
                      Last score:{" "}
                      {scoresByQuiz[q.id] != null ? (
                        <span
                          className={
                            scoresByQuiz[q.id] >= 90
                              ? "text-green-400 font-semibold"
                              : ""
                          }
                        >
                          {scoresByQuiz[q.id]}%
                        </span>
                      ) : (
                        "—"
                      )}
                    </div>
                  </div>
                </div>

                {/* RIGHT: actions */}
                <div className="flex flex-wrap gap-2">
                  <Link
                    to={`/play/${q.id}`}
                    className={`${btnBase} ${btnGray}`}
                  >
                    Play
                  </Link>
                  <Link
                    to={`/edit/${q.id}`}
                    className={`${btnBase} ${btnGray}`}
                  >
                    Edit
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
                    className={`${btnBase} ${btnGray}`}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Group actions under the list (only when a specific group is filtered) */}
        {filterGroupId && filterGroupId !== NO_GROUP && currentGroup && (
          <div className="mt-6 flex items-center gap-3">
            <button
              onClick={openEditGroup}
              className={`${btnBase} ${btnGray}`}
            >
              Edit Group Name
            </button>
            <button
              onClick={() => setDeleteGroupOpen(true)}
              className={`${btnBase} ${btnRed}`}
            >
              Delete “{currentGroup.name}” group
            </button>
          </div>
        )}
      </main>

      {/* single delete */}
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

      {/* Auth modal: upgrade guest OR sign in */}
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
            <h2 className="text-xl font-bold mb-2">Create account or sign in</h2>

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

            <div className="flex flex-col sm:flex-row justify-end gap-2">
              <button
                className={`${btnBase} ${btnGray}`}
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
                className={`${btnBase} ${btnGreen}`}
                onClick={handleCreateAccount}
                disabled={authBusy}
                title="Upgrade this guest to an email/password account"
              >
                {authBusy ? "Working…" : "Create account"}
              </button>

              <button
                className={`${btnBase} ${btnGray}`}
                onClick={async () => {
                  const ok = confirm(
                    "Signing in to an existing account will replace your guest session. Continue?"
                  );
                  if (ok) await signInExisting();
                }}
                disabled={authBusy}
                title="Sign in to an existing account (replaces guest session)"
              >
                Sign in instead
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI generate */}
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
                <label
                  className="block text-sm text-gray-300 mb-1"
                  htmlFor="gen-title"
                >
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
                <label
                  className="block text-sm text-gray-300 mb-1"
                  htmlFor="gen-topic"
                >
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

              {/* NEW: Do not repeat previous questions */}
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

              {/* Optional source file (PDF/TXT/MD) */}
              <div className="sm:col-span-2">
                <label
                  className="block text-sm text-gray-300 mb-1"
                  htmlFor="gen-file"
                >
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
                <label
                  className="block text-sm text-gray-300 mb-1"
                  htmlFor="gen-group"
                >
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
                <label
                  className="block text-sm text-gray-300 mb-1"
                  htmlFor="gen-count"
                >
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

      {/* --- NEW: Bulk Delete modal (restored) --- */}
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
      <h2 className="text-xl font-bold mb-2">Delete selected quizzes?</h2>

      <p className="text-gray-300 mb-4">
        You have selected:
        <span className="block mt-1 font-semibold break-words">
          {selectedTitles.join(", ")}
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
      {/* --- NEW: Move to Group modal (restored) --- */}
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
                  If you enter a name here, a new group will be created and used.
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

      {/* Delete current group modal */}
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
              This deletes the group <span className="font-semibold">
                {currentGroup.name}
              </span>{" "}
              and all quizzes inside it.
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

      {/* Edit group name modal */}
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

      {/* Empty group cleanup modal */}
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
              The group <span className="font-semibold">{cleanupGroup.name}</span>{" "}
              is now empty. Would you like to delete it?
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
    </div>
  );
}
