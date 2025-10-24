// src/pages/Dashboard.jsx
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";

import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/build/pdf.mjs";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url"; // <-- Vite will emit an asset URL
GlobalWorkerOptions.workerSrc = workerSrc;



export default function Dashboard() {
  // auth
const { user, ready, signout } = useAuth();

// Robust anonymous detector that covers multiple SDK shapes
function computeIsAnon(u) {
  if (!u) return false;

  const prov = u.app_metadata?.provider || null;
  const provs = Array.isArray(u.app_metadata?.providers)
    ? u.app_metadata.providers
    : [];

  return (
    u.is_anonymous === true ||                        // sometimes top-level
    u.user_metadata?.is_anonymous === true ||         // sometimes in user_metadata
    prov === "anonymous" ||                           // single provider
    provs.includes("anonymous") ||                    // providers array
    (Array.isArray(u.identities) &&
      u.identities.some((i) => i?.provider === "anonymous")) ||
    // fallback: no email and no non-anon providers known
    (!u.email && (provs.length === 0 || provs.includes("anonymous")))
  );
}

const isAnon = computeIsAnon(user);

// (optional) temporary logger — remove after verifying
useEffect(() => {
  if (!ready) return;
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
  async function upgradeToEmailPassword() {
  try {
    setAuthBusy(true);

    const email = (authEmail || "").trim();
    const password = authPass || "";

    if (!email || !password) {
      alert("Please enter email and password.");
      return;
    }

    // Step 1: set email (may trigger a confirmation email depending on your project settings)
    const { error: e1 } = await supabase.auth.updateUser({ email });
    if (e1) {
      alert(e1.message || "Failed to set email.");
      return;
    }

    // Step 2: set password (some projects require confirming email before this succeeds)
    const { error: e2 } = await supabase.auth.updateUser({ password });
    if (e2) {
      alert(e2.message || "Failed to set password.");
      return;
    }

    alert("Account created! You’re now signed in with email/password.");
    setAuthMessage("");     // <-- clear any trial message
    setAuthOpen(false);     // close modal
  } catch (err) {
    console.error(err);
    alert("Something went wrong. Please try again.");
  } finally {
    setAuthBusy(false);
  }
}

// (Optional) Sign in to existing account (replaces the guest session)
// NOTE: This will NOT merge guest data. Prefer upgradeToEmailPassword above.
async function signInExisting() {
  try {
    setAuthBusy(true);

    const email = (authEmail || "").trim();
    const password = authPass || "";

    if (!email || !password) {
      alert("Please enter email and password.");
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      alert(error.message || "Failed to sign in.");
      return;
    }

    setAuthMessage("");     // <-- clear any trial message
    setAuthOpen(false);     // close modal
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
  setAuthMessage("You’re signed out. Sign in or create an account to save your progress.");
  setAuthOpen(true);
}

  // guest trial state (limit = 2)
  const [trial, setTrial] = useState({ isAnon: false, remaining: Infinity, loading: true });

  // Open our nice modal with a friendly message (only used when trial cap is hit)
function openSignupModal(msg) {
  setAuthMessage(msg || "Free trial limit reached. Create an account to make more quizzes.");
  setAuthOpen(true);
}

  // single delete
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [target, setTarget] = useState(null); // { id, title, group_id }
  const [deleting, setDeleting] = useState(false);

  // AI generate
const [genOpen, setGenOpen] = useState(false);

// leave these empty so the UI shows placeholders instead of hard text
const [gTitle, setGTitle]   = useState("");
const [gTopic, setGTopic]   = useState("");
const [gCount, setGCount] = useState(10);
const [generating, setGenerating] = useState(false);
const [creating, setCreating]     = useState(false);
const [gGroupId, setGGroupId]     = useState(""); // "" => No group
const [gFile, setGFile]           = useState(null);


  // create group inside AI modal
  const [gNewOpen, setGNewOpen] = useState(false);
  const [gNewName, setGNewName] = useState("");
  const [gCreatingGroup, setGCreatingGroup] = useState(false);

  // groups + filter
  const [groups, setGroups] = useState([]); // { id, name }[]
  const [filterGroupId, setFilterGroupId] = useState(""); // ""=all, "__none__"=no group
  // const [scoreSort, setScoreSort] = useState("asc"); // temporarily disabled UI
const scoreSort = "asc"; // keep behavior: lowest scores first by default


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
  const currentGroup =
    groups.find((g) => g.id === filterGroupId) || null;

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
  } else if (filterGroupId === "__none__") {
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
    (async () => {
      const { data } = await supabase
        .from("groups")
        .select("id, name")
        .eq("user_id", user.id)
        .order("name", { ascending: true });
      setGroups(data ?? []);
    })();
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
      .select("id", { count: "exact", head: true });
    setTrial({
      isAnon: true,
      remaining: Math.max(0, 2 - (count ?? 0)),
      loading: false,
    });
  })();
}, [isAnon, user?.id, quizzes.length]); // re-check after list changes

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
      // drop this id and try next
      setCleanupQueue((q) => q.slice(1));
    }
  }

  // Ensure the queue gets processed whenever it changes / modal closes
  useEffect(() => {
    if (!cleanupOpen) {
      // let state settle then try
      setTimeout(runNextCleanupIfIdle, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setCreating(true);
    const { data, error } = await supabase
      .from("quizzes")
      .insert({ user_id: user.id, title: "Untitled Quiz", questions: [] })
      .select("id")
      .single();

    if (error) {
      // RLS block when guest over the trial cap
      if (error.code === "42501") {
        openSignupModal("Free trial limit reached. Create an account to make more quizzes.");
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

      // also clear from multi-select
      setSelectedIds((prev) => {
        if (!prev.has(thisId)) return prev;
        const next = new Set(prev);
        next.delete(thisId);
        return next;
      });

      if (thisGroupId) {
        enqueueEmptyGroups([thisGroupId]);
      }
    } else {
      alert("Failed to delete. Please try again.");
    }
  }

   // Extract text from user file (PDF/TXT/MD)
  async function extractTextFromFile(file) {
    // Plain text / Markdown path
    if (
      file.type?.startsWith("text/") ||
      file.name.toLowerCase().endsWith(".txt") ||
      file.name.toLowerCase().endsWith(".md")
    ) {
      const asText = await file.text();
      return asText;
    }

    // PDF path
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
        out += content.items.map(it => it.str).join(" ") + "\n";
      }
      return out;
    }

    // Fallback: try as text
  return await file.text();
}

// Quick preflight: block guests at/over the limit before doing any work
async function ensureCanCreate() {
  // Re-check anon status + count right now (fresh)
  const { data: ures } = await supabase.auth.getUser();
  const anon =
    !!ures?.user &&
    Array.isArray(ures.user.identities) &&
    ures.user.identities.some((i) => i?.provider === "anonymous");

  if (!anon) return true;

  const { count } = await supabase
    .from("quizzes")
    .select("id", { count: "exact", head: true });

  if ((count ?? 0) >= 2) {
    openSignupModal("Free trial limit reached. Create an account to make more quizzes.");
    return false;
  }
  return true;
}

 // ---------- AI generate ----------
// Replace your existing generateQuiz() with this version
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

    // 1) Optional: index uploaded file (RAG)
    let file_id = null; // <-- fixed: no TypeScript type here
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
      try { idxOut = idxText ? JSON.parse(idxText) : {}; } catch {}
      file_id = idxOut?.file_id ?? null;
      if (!file_id) {
        alert("Indexing returned no file_id.");
        setGenerating(false);
        return;
      }
    }

    // 2) Generate quiz (works even when file_id is null)
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-quiz`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        },
        body: JSON.stringify({
          // Use sensible defaults if fields are left blank
          title: (gTitle || "").trim() || "Bash Top 10",
          topic:
            (gTopic || "").trim() ||
            "Create 10 questions that test the 10 most-used Bash commands.",
          count,
          group_id: gGroupId || null,
          file_id,
        }),
      }
    );

    let raw = "";
    try { raw = await res.text(); } catch {}

    if (!res.ok) {
      if (res.status === 403) {
        openSignupModal("Free trial limit reached. Create an account to make more quizzes.");
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
        setGroups((gs) => [...gs, data].sort((a, b) => a.name.localeCompare(b.name)));
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

      // Prompt for each group that became empty (queue; shows one-by-one)
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
        setGroups((gs) => [...gs, g].sort((a, b) => a.name.localeCompare(b.name)));
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

      // Previous groups that might now be empty (exclude the new one)
      const toCheck = prevGroupIds.filter((gid) => gid !== (targetGroupId || null));
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
    setDeletingGroup(true);
    try {
      // 1) delete quizzes in this group
      const { error: qErr } = await supabase
        .from("quizzes")
        .delete()
        .eq("user_id", user.id)
        .eq("group_id", currentGroup.id);
      if (qErr) throw qErr;

      // 2) delete the group itself
      const { error: gErr } = await supabase
        .from("groups")
        .delete()
        .eq("user_id", user.id)
        .eq("id", currentGroup.id);
      if (gErr) throw gErr;

      // 3) UI updates
      setDeleteGroupOpen(false);
      setGroups((gs) => gs.filter((g) => g.id !== currentGroup.id));
      setFilterGroupId(""); // back to “All groups”
      await load();         // refresh list
    } catch (e) {
      console.error(e);
      alert("Failed to delete group. Please try again.");
    } finally {
      setDeletingGroup(false);
    }
  }

  // ---------- UI ----------
  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="flex items-center justify-between p-4 border-b border-gray-800">
  <h1 className="text-xl font-bold">Your Quizzes</h1>

  <div className="flex items-center gap-3 text-sm">
    {!ready ? (
      <span className="text-gray-400">Loading…</span>
    ) : isAnon ? (
      <>
        <span className="text-gray-300">Guest</span>
        {/* Guest button: open clean modal (no trial text) */}
        <button
          onClick={() => { setAuthMessage(""); setAuthOpen(true); }}
          className="px-3 py-1 rounded bg-emerald-500 hover:bg-emerald-600 font-semibold"
        >
          Sign Up / Sign In
        </button>
      </>
    ) : user ? (
      <>
        <span className="text-gray-300">{user.email}</span>
        <button
          onClick={handleSignOut /* this should setAuthMessage(...) and setAuthOpen(true) as we added earlier */}
          className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
        >
          Sign out
        </button>
      </>
    ) : (
      // Fallback when there's no user yet: open clean modal (no trial text)
      <button
        onClick={() => { setAuthMessage(""); setAuthOpen(true); }}
        className="px-3 py-1 rounded bg-emerald-500 hover:bg-emerald-600 font-semibold"
      >
        Sign Up / Sign In
      </button>
    )}
  </div>
</header>
      <main className="max-w-3xl mx-auto p-6">
        {/* TOOLBAR (single row, no wrapping/collapse) */}
        <div className="mb-6 flex flex-nowrap items-center gap-3">
          {/* Left: primary actions */}
          <div className="flex items-center gap-3 shrink-0">            
            <button
  onClick={async () => {
    if (filterGroupId && filterGroupId !== "__none__") setGGroupId(filterGroupId);
    else setGGroupId("");

    // Preflight: block instantly if at limit
    const allowed = await ensureCanCreate();
    if (!allowed) return;

    setGenOpen(true);
  }}
  className="px-4 py-2 rounded bg-emerald-500 hover:bg-emerald-600 font-semibold disabled:opacity-60"
>
  + Generate Quiz with AI
</button>
          </div>

          {/* Right: filters stacked, with bulk actions underneath (not crammed to the side) */}
<div className="ml-auto flex flex-col items-end gap-3 min-w-0">
  {/* Filter by group */}
  <div className="flex items-center gap-2">
    <label className="text-sm text-gray-300 shrink-0">Filter by group:</label>
    <select
      className="w-48 shrink-0 p-2 rounded bg-gray-800 text-white border border-gray-700"
      value={filterGroupId}
      onChange={(e) => setFilterGroupId(e.target.value)}
    >
      <option value="">All</option>
      <option value="__none__">No group</option>
      {groups.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
    </select>
  </div>

  {/* Filter by score 
  <div className="flex items-center gap-2">
    <label className="text-sm text-gray-300 shrink-0">Filter by score:</label>
    <select
      className="w-48 shrink-0 p-2 rounded bg-gray-800 text-white border border-gray-700"
      value={scoreSort}
      onChange={(e) => setScoreSort(e.target.value)}
    >
      <option value="asc">Lowest scores first</option>
      <option value="desc">Highest scores first</option>
    </select>
  </div> */}

  {/* Bulk actions appear neatly UNDER the filters */}
  {hasSelected && (
    <div className="flex items-center gap-2">
      <button
        onClick={() => setMoveOpen(true)}
        className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
      >
        Move to group
      </button>
      <button
        onClick={() => setBulkConfirmOpen(true)}
        className="px-3 py-2 rounded bg-red-600 hover:bg-red-700"
      >
        Delete selected
      </button>
    </div>
  )}
</div>
        </div>

        {/* LIST */}
{quizzes.length === 0 ? (
  <div className="text-gray-400">No quizzes yet. Create one or generate with AI.</div>
) : (
  <ul className="space-y-3">
    {[...quizzes]
      .sort((a, b) => {
        const av = scoresByQuiz[a.id];
        const bv = scoresByQuiz[b.id];
        // Put “no score” items at the bottom for both directions
        const aVal = av == null ? (scoreSort === "asc" ? Infinity : -Infinity) : av;
        const bVal = bv == null ? (scoreSort === "asc" ? Infinity : -Infinity) : bv;
        return scoreSort === "asc" ? aVal - bVal : bVal - aVal;
      })
      .map((q) => (
        <li
          key={q.id}
          className="bg-gray-800 rounded-xl p-4 flex items-center justify-between"
        >
          {/* LEFT: checkbox + title/meta */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              className="h-5 w-5 accent-emerald-500"
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
    <span className={scoresByQuiz[q.id] >= 90 ? "text-green-400 font-semibold" : ""}>
      {scoresByQuiz[q.id]}%
    </span>
  ) : (
    "—"
  )}
</div>
            </div>
          </div>

          {/* RIGHT: actions */}
          <div className="flex gap-2">
            <Link
              to={`/play/${q.id}`}
              className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
            >
              Play
            </Link>
            <Link
              to={`/edit/${q.id}`}
              className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
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
              className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
            >
              Delete
            </button>
          </div>
        </li>
      ))}
  </ul>
)}

{/* Delete-current-group button (only when a specific group is filtered) */}
{filterGroupId && filterGroupId !== "__none__" && currentGroup && (
  <div className="mt-6">
    <button
      onClick={() => setDeleteGroupOpen(true)}
      className="px-4 py-2 rounded bg-gray-700 hover:bg-red-700"
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
      if (e.key === "Enter") handleDelete();
    }}
    onClick={() => !deleting && setConfirmOpen(false)}
  >
    <div
      className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      <h2 className="text-xl font-bold mb-2">Delete quiz?</h2>
      <p className="text-gray-300 mb-6">
        Are you sure you want to delete{" "}
        <span className="font-semibold">{target?.title}</span>? This cannot be undone.
      </p>
      <div className="flex justify-end gap-2">
        <button
          className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
          onClick={() => setConfirmOpen(false)}
          disabled={deleting}
        >
          Cancel
        </button>
        <button
          className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
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
        setAuthMessage("");   // <-- clear trial text on close
        setAuthOpen(false);
      }
    }}
    aria-modal="true"
    role="dialog"
  >
    <div
      className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      <h2 className="text-xl font-bold mb-2">Create account or sign in</h2>

      {/* Friendly trial message */}
      <div className="mb-4 rounded-lg bg-emerald-900/30 border border-emerald-800 p-3 text-sm">
        {authMessage || "Free trial limit reached. Create an account to make more quizzes."}
      </div>

      <p className="text-gray-300 mb-4 text-sm">
        Creating an account upgrades your current guest session so your quizzes stay with you.
      </p>

      <label className="block text-sm text-gray-300 mb-1" htmlFor="auth-email">Email</label>
      <input
        id="auth-email"
        className="w-full p-3 rounded bg-gray-900 text-white border border-gray-700 mb-3"
        type="email"
        placeholder="you@example.com"
        value={authEmail}
        onChange={(e) => setAuthEmail(e.target.value)}
        autoFocus
      />

      <label className="block text-sm text-gray-300 mb-1" htmlFor="auth-pass">Password</label>
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
          className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-60"
          onClick={() => {
            if (!authBusy) {
              setAuthMessage(""); // <-- clear trial text on close
              setAuthOpen(false);
            }
          }}
          disabled={authBusy}
        >
          Not now
        </button>

        {/* Primary: upgrade guest to email/password (preserves data) */}
        <button
          className="px-3 py-2 rounded bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60"
          onClick={upgradeToEmailPassword}
          disabled={authBusy}
          title="Upgrade this guest to an email/password account"
        >
          {authBusy ? "Working…" : "Create account"}
        </button>

        {/* Secondary: sign in to existing account (replaces guest session) */}
        <button
          className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-60"
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
            className="w-full max-w-xl bg-gray-800 text-white rounded-2xl p-6 shadow-xl"
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

                            {/* Optional source file (PDF/TXT/MD) */}
              <div className="sm:col-span-2">
                <label className="block text-sm text-gray-300 mb-1" htmlFor="gen-file">
                  Optional document (PDF / TXT / MD)
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
                  Group
                </label>
                <div className="flex gap-2">
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
                    className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 whitespace-nowrap"
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
                  className="field w-20 text-left pl-4"
                  type="number"
                  min={1}
                  max={30}
                  value={gCount}
                  onChange={(e) => setGCount(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
                onClick={() => setGenOpen(false)}
                disabled={generating}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 rounded bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60"
                onClick={generateQuiz}
                disabled={generating}
              >
                {generating ? "Generating…" : "Generate"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New group (AI modal) */}
      {gNewOpen && (
        <div
          className="fixed inset-0 bg-black/70 grid place-items-center z-[65]"
          onClick={() => setGNewOpen(false)}
        >
          <div
            className="w-full max-w-sm bg-gray-800 text-white rounded-2xl p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold mb-3">Create new group</h3>
            <input
              className="w-full p-3 rounded bg-gray-900 text-white border border-gray-700 mb-4"
              placeholder="Group name"
              value={gNewName}
              onChange={(e) => setGNewName(e.target.value)}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
                onClick={() => setGNewOpen(false)}
                disabled={gCreatingGroup}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 rounded bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60"
                onClick={createGroupForModal}
                disabled={gCreatingGroup || !gNewName.trim()}
              >
                {gCreatingGroup ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* cleanup modal (queue-driven) */}
      {cleanupOpen && cleanupGroup && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-[70]"
          onClick={() => !cleaning && keepEmptyGroupNow()}
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2">Delete empty group?</h2>
            <p className="text-gray-300 mb-6">
              The group <span className="font-semibold">{cleanupGroup.name}</span> no longer has any
              quizzes. Would you like to delete this group?
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
                onClick={keepEmptyGroupNow}
                disabled={cleaning}
              >
                Keep group
              </button>
              <button
                className="px-3 py-1 rounded bg-red-500 hover:bg-red-600 disabled:opacity-60"
                onClick={deleteEmptyGroupNow}
                disabled={cleaning}
              >
                {cleaning ? "Deleting…" : "Delete group"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete current group (confirm) */}
      {deleteGroupOpen && currentGroup && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-[85]"
          onClick={() => !deletingGroup && setDeleteGroupOpen(false)}
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2">Delete this group?</h2>
            <p className="text-gray-300 mb-6">
              You’re about to delete the group{" "}
              <span className="font-semibold">“{currentGroup.name}”</span>.
              All quizzes in this group will also be deleted. Continue?
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
                onClick={() => setDeleteGroupOpen(false)}
                disabled={deletingGroup}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 rounded bg-red-600 hover:bg-red-700 disabled:opacity-60"
                onClick={deleteCurrentGroupNow}
                disabled={deletingGroup}
              >
                {deletingGroup ? "Deleting…" : "Delete group"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* bulk delete confirm */}
      {bulkConfirmOpen && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-[75]"
          onClick={() => !bulkDeleting && setBulkConfirmOpen(false)}
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2">Delete selected quizzes?</h2>
            <p className="text-gray-300 mb-6">
              You’re about to delete <span className="font-semibold">{selectedIds.size}</span>{" "}
              {selectedIds.size === 1 ? "quiz" : "quizzes"}. This can’t be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
                onClick={() => setBulkConfirmOpen(false)}
                disabled={bulkDeleting}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 rounded bg-red-600 hover:bg-red-700 disabled:opacity-60"
                onClick={doBulkDelete}
                disabled={bulkDeleting}
              >
                {bulkDeleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* bulk move */}
      {moveOpen && (
        <div
          className="fixed inset-0 bg-black/70 grid place-items-center z-[80]"
          onClick={() => !moving && setMoveOpen(false)}
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-4">Move selected quizzes</h2>
            <p className="text-gray-300 mb-4">
              Selected: <span className="font-semibold">{selectedIds.size}</span>
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-300 mb-1" htmlFor="move-existing">
                  Move to existing group
                </label>
                <select
                  id="move-existing"
                  className="w-full p-3 rounded bg-gray-800 text-white border border-gray-700"
                  value={moveGroupId}
                  onChange={(e) => setMoveGroupId(e.target.value)}
                >
                  <option value="">Choose group…</option>
                  <option value="__none__">No group</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-gray-300 mb-1" htmlFor="move-new">
                  Or create & move to new group
                </label>
                <input
                  id="move-new"
                  className="w-full p-3 rounded bg-gray-800 text-white border border-gray-700"
                  placeholder="New group name"
                  value={moveNewName}
                  onChange={(e) => setMoveNewName(e.target.value)}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
                onClick={() => setMoveOpen(false)}
                disabled={moving}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 rounded bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60"
                onClick={doBulkMove}
                disabled={moving || (!moveNewName.trim() && moveGroupId === "")}
                title={
                  moveNewName.trim()
                    ? "Create new group and move"
                    : moveGroupId
                    ? "Move to selected group"
                    : "Select a target or enter a new group name"
                }
              >
                {moving ? "Moving…" : "Move"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
