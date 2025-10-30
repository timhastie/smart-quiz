// src/pages/Editor.jsx
import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

// For PDF extraction (same as Dashboard)
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/build/pdf.mjs";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = workerSrc;

export default function Editor() {
  const { user, ready } = useAuth();
  const { quizId } = useParams();

  // Quiz fields
  const [title, setTitle] = useState("");
  const [questions, setQuestions] = useState([]);
  const [groupId, setGroupId] = useState(""); // "" => No group
  const [msg, setMsg] = useState("");

  // Persisted meta (prompt & prior file info, if present)
  const [sourcePrompt, setSourcePrompt] = useState("");
  const [savedFileId, setSavedFileId] = useState(null);       // nullable
  const [savedFileName, setSavedFileName] = useState(null);   // nullable

  // Groups
  const [groups, setGroups] = useState([]); // [{id, name}]
  const [savingGroup, setSavingGroup] = useState(false);
  const prevGroupRef = useRef(null);

  // New group modal
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);

  // Empty-group cleanup modal (after moving out)
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupGroup, setCleanupGroup] = useState(null); // { id, name }
  const [cleaning, setCleaning] = useState(false);

  // --- Generate-with-AI (Regenerate) modal ---
  const [genOpen, setGenOpen] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Modal fields (prefilled from quiz on open)
  const [gTitle, setGTitle] = useState("");
  const [gTopic, setGTopic] = useState("");

  // NOTE: keep count as a STRING so users can freely delete/type without "01" issues
  const [gCountStr, setGCountStr] = useState("10");

  const [gGroupId, setGGroupId] = useState(""); // "" => No group
  const [gFile, setGFile] = useState(null);     // newly uploaded file (optional)
  const [gKeepSavedFile, setGKeepSavedFile] = useState(true); // keep previous file if present
  const [gNoRepeat, setGNoRepeat] = useState(true); // consistent with Dashboard

  // generation mode ("add" | "replace")
  const [gMode, setGMode] = useState("add"); // default to "Add to existing questions"

  // Ref to clear the <input type="file"> when toggling checkbox on
  const fileInputRef = useRef(null);

  // ----- UI button helpers (match Dashboard look) -----
  const pressAnim = "transition-transform duration-100 active:scale-95";
  const btnBase = "px-3 py-2 rounded disabled:opacity-60 disabled:cursor-not-allowed";
  const btnGray = `bg-gray-700 hover:bg-gray-600 ${pressAnim}`;
  const btnGreen = `bg-emerald-500 hover:bg-emerald-600 font-semibold ${pressAnim}`;
  const btnRed = `bg-red-500 hover:bg-red-600 ${pressAnim}`;

  // ---------- selection state for multi-delete ----------
  const [selected, setSelected] = useState(new Set()); // indices

  function toggleSelect(i) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }
  function clearSelection() {
    setSelected(new Set());
  }
  const selectedCount = selected.size;

  async function deleteSelected() {
    if (selected.size === 0) return;
    const keep = questions.filter((_, idx) => !selected.has(idx));
    const { error } = await supabase
      .from("quizzes")
      .update({
        questions: keep,
        updated_at: new Date().toISOString(),
      })
      .eq("id", quizId)
      .eq("user_id", user.id);

    if (!error) {
      setQuestions(keep);
      const n = selected.size;
      clearSelection();
      setMsg(`Deleted ${n} question${n > 1 ? "s" : ""}.`);
      setTimeout(() => setMsg(""), 1500);
    } else {
      alert("Failed to delete selected questions. Please try again.");
    }
  }

  // ---------- load data ----------
  async function loadGroups() {
    const { data, error } = await supabase
      .from("groups")
      .select("id, name")
      .eq("user_id", user.id)
      .order("name", { ascending: true });
    if (!error) setGroups(data ?? []);
  }

  async function loadQuiz() {
    const { data, error } = await supabase
      .from("quizzes")
      .select("*")
      .eq("id", quizId)
      .eq("user_id", user.id)
      .single();

    if (!error && data) {
      setTitle(data.title || "");
      setQuestions(Array.isArray(data.questions) ? data.questions : []);
      const gid = data.group_id || "";
      setGroupId(gid);
      prevGroupRef.current = gid || null;

      setSourcePrompt(data.source_prompt || "");
      setSavedFileId(data.file_id ?? null);
      setSavedFileName(data.source_file_name ?? null);
    } else {
      setTitle((t) => t || "");
      setQuestions((q) => q || []);
    }
  }

  useEffect(() => {
    if (!ready || !user?.id) return;
    (async () => {
      await loadGroups();
      await loadQuiz();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, user?.id, quizId]);

  // ---------- basic editing ----------
  function addRow() {
    setQuestions((q) => [...q, { prompt: "", answer: "" }]);
  }
  function updateRow(i, key, val) {
    setQuestions((q) =>
      q.map((row, idx) => (idx === i ? { ...row, [key]: val } : row))
    );
  }
  function removeRow(i) {
    setQuestions((q) => q.filter((_, idx) => idx !== i));
    clearSelection();
  }

  async function save() {
    const { error } = await supabase
      .from("quizzes")
      .update({
        title,
        questions,
        group_id: groupId || null,
        source_prompt: sourcePrompt || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", quizId)
      .eq("user_id", user.id);

    if (!error) {
      setMsg("Saved!");
      setTimeout(() => setMsg(""), 1500);
    }
  }

  // ---------- group helpers ----------
  async function maybePromptDeleteEmptyGroup(groupIdToCheck) {
    if (!groupIdToCheck) return;
    const { count, error } = await supabase
      .from("quizzes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("group_id", groupIdToCheck);
    if (error) return;
    if ((count ?? 0) === 0) {
      const { data: g, error: gErr } = await supabase
        .from("groups")
        .select("id, name")
        .eq("id", groupIdToCheck)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!gErr && g?.id) {
        setCleanupGroup({ id: g.id, name: g.name });
        setCleanupOpen(true);
      }
    }
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
        setCleanupOpen(false);
        setCleanupGroup(null);
      } else {
        alert("Failed to delete group. Please try again.");
      }
    } finally {
      setCleaning(false);
    }
  }

  async function handleGroupChange(e) {
    const next = e.target.value; // "" or group id
    const prev = prevGroupRef.current;
    setGroupId(next);
    try {
      setSavingGroup(true);
      const { error } = await supabase
        .from("quizzes")
        .update({
          group_id: next || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", quizId)
        .eq("user_id", user.id);
      if (!error) {
        setMsg("Saved!");
        setTimeout(() => setMsg(""), 1200);
        if (prev && prev !== (next || null)) {
          setTimeout(() => maybePromptDeleteEmptyGroup(prev), 0);
        }
        prevGroupRef.current = next || null;
      } else {
        alert("Failed to save group. Please try again.");
      }
    } finally {
      setSavingGroup(false);
    }
  }

  async function createGroup() {
    if (!newName.trim() || creatingGroup) return;
    try {
      setCreatingGroup(true);
      const { data, error } = await supabase
        .from("groups")
        .insert({ user_id: user.id, name: newName.trim() })
        .select("id, name")
        .single();
      if (error || !data) {
        console.error("createGroup error:", error);
        return;
      }
      setGroups((gs) => [...gs, data].sort((a, b) => a.name.localeCompare(b.name)));
      const prev = prevGroupRef.current;
      setGroupId(data.id);
      const { error: linkErr } = await supabase
        .from("quizzes")
        .update({ group_id: data.id, updated_at: new Date().toISOString() })
        .eq("id", quizId)
        .eq("user_id", user.id);
      if (!linkErr) {
        if (prev && prev !== data.id) setTimeout(() => maybePromptDeleteEmptyGroup(prev), 0);
        prevGroupRef.current = data.id;
      }
      setNewOpen(false);
      setNewName("");
      setMsg("Saved!");
      setTimeout(() => setMsg(""), 1200);
    } finally {
      setCreatingGroup(false);
    }
  }

  // ---------- file helpers ----------
  async function extractTextFromFile(file) {
    if (
      file.type?.startsWith("text/") ||
      file.name.toLowerCase().endsWith(".txt") ||
      file.name.toLowerCase().endsWith(".md")
    ) {
      return await file.text();
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

  // ---------- open the Generate-with-AI modal prefilled ----------
  function openRegenerateModalPrefilled() {
    setGTitle(title || "");
    setGTopic(sourcePrompt || "");
    // Default: if adding, start with 5; if replacing, default to current length (or 10)
    const curr = Array.isArray(questions) ? questions.length : 0;
    const defReplace = String(Math.max(1, Math.min(curr || 10, 30)));
    const defAdd = "5";
    setGCountStr(gMode === "replace" ? defReplace : defAdd);
    setGGroupId(groupId || "");
    setGNoRepeat(true);
    setGFile(null);
    setGKeepSavedFile(!!savedFileId);
    setGenOpen(true);
  }

  // Derived counts for validation
  const currentCount = Array.isArray(questions) ? questions.length : 0;
  const MAX_TOTAL = 30;
  const maxAdd = Math.max(0, MAX_TOTAL - currentCount);
  const isAdd = gMode === "add";

  // Cleanly toggle the mutually exclusive mode checkboxes
  function chooseAdd() {
  setGMode("add");
  // Default back to 5 when returning to "Add"
  // but respect the remaining headroom to the 30 cap.
  const maxAddLocal = Math.max(0, MAX_TOTAL - currentCount);
  if (maxAddLocal <= 0) {
    // Can't add any more; keep a harmless value (submission will alert)
    setGCountStr("1");
    return;
  }
  const defaultAdd = Math.min(5, maxAddLocal); // prefer 5, clamp if near the cap
  setGCountStr(String(defaultAdd));
}
  function chooseReplace() {
    setGMode("replace");
    const curr = currentCount || 10;
    setGCountStr(String(Math.min(Math.max(1, curr), 30)));
  }

  // ----- count input handlers (accept free deletion, strip leading zeros, enforce caps) -----
  function normalizeDigits(s) {
    // remove leading zeros but keep single "0" as "" during typing
    if (s === "") return "";
    const n = parseInt(s, 10);
    if (Number.isNaN(n)) return "";
    return String(n);
  }

  function handleCountChange(e) {
    let v = e.target.value;
    // allow only digits or empty
    if (!/^\d*$/.test(v)) return;
    // free delete permitted
    setGCountStr(v);
  }

  function handleCountBlur() {
    // On blur, coerce to valid range and show popups when exceeding caps
    const typed = parseInt(gCountStr, 10);
    let n = Number.isNaN(typed) ? 1 : typed;

    if (n < 1) n = 1;

    if (isAdd) {
      if (n > maxAdd) {
        if (maxAdd <= 0) {
          alert("You can add a maximum of 0 questions.");
          n = 1; // keep a sensible value in the box; action will be blocked on submit
        } else {
          alert(`You can add a maximum of ${maxAdd} question${maxAdd === 1 ? "" : "s"}.`);
          n = maxAdd;
        }
      }
    } else {
      if (n > MAX_TOTAL) {
        alert("Maximum 30 questions");
        n = MAX_TOTAL;
      }
    }

    setGCountStr(String(n));
  }

  // Helper: get newly created quiz's questions
  async function fetchQuizQuestionsById(id) {
    const { data, error } = await supabase
      .from("quizzes")
      .select("questions")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();
    if (error) throw error;
    return Array.isArray(data?.questions) ? data.questions : [];
  }

  // ---------- call Edge Function (add vs replace) ----------
  async function regenerateFromModal() {
    try {
      if (generating) return;
      setGenerating(true);

      const { data: sessionRes } = await supabase.auth.getSession();
      const jwt = sessionRes?.session?.access_token;

      // Optional: index newly uploaded file
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
      } else if (gKeepSavedFile && savedFileId) {
        file_id = savedFileId;
      } else {
        file_id = null;
      }

      // Parse and validate the requested count
      let requested = parseInt(gCountStr, 10);
      if (Number.isNaN(requested) || requested < 1) requested = 1;

      let count; // how many to ask the Edge Function to generate
      if (isAdd) {
        if (maxAdd <= 0) {
          alert("You can add a maximum of 0 questions.");
          setGenerating(false);
          return;
        }
        if (requested > maxAdd) {
          alert(`You can add a maximum of ${maxAdd} question${maxAdd === 1 ? "" : "s"}.`);
          requested = maxAdd;
          setGCountStr(String(requested));
        }
        count = requested; // generate exactly the number to add
      } else {
        if (requested > MAX_TOTAL) {
          alert("Maximum 30 questions");
          requested = MAX_TOTAL;
          setGCountStr(String(requested));
        }
        count = requested; // replace with exactly this many
      }

      // ===== Build avoid_prompts like Dashboard =====
      const targetGroupIdForNoRepeat =
        (gGroupId && gGroupId !== "") ? gGroupId : (groupId || "");

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
      // ===================================================

      // Shared request body
      const baseBody = {
        title: (gTitle || "").trim() || "Untitled Quiz",
        topic: (gTopic || "").trim() || "Create a short quiz.",
        count,
        group_id: gGroupId || null,
        file_id,
        no_repeat: !!gNoRepeat,
        avoid_prompts,
        source_prompt: (gTopic || "").trim() || null,
        source_file_name: gFile ? gFile.name : (gKeepSavedFile ? savedFileName : null),
      };

      if (!isAdd) {
        // Replace all questions in-place
        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-quiz`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
            },
            body: JSON.stringify({
              ...baseBody,
              replace_quiz_id: quizId,
            }),
          }
        );
        const raw = await res.text();
        if (!res.ok) {
          alert(`Failed to regenerate (${res.status}):\n${raw || "Unknown error"}`);
          setGenerating(false);
          return;
        }
        await loadQuiz();
        setMsg("Quiz replaced with new questions.");
        setTimeout(() => setMsg(""), 1500);
        setGenOpen(false);
        return;
      }

      // Add mode: create a temporary quiz, pull its questions, append, then delete that temp quiz.
      const createRes = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-quiz`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
          },
          body: JSON.stringify({
            ...baseBody,
            replace_quiz_id: null, // ensure a fresh quiz is created
          }),
        }
      );
      const createText = await createRes.text();
      if (!createRes.ok) {
        alert(`Failed to generate new questions (${createRes.status}):\n${createText || "Unknown error"}`);
        setGenerating(false);
        return;
      }

      let createOut = {};
      try { createOut = createText ? JSON.parse(createText) : {}; } catch {}
      const newQuizId = createOut?.id;
      if (!newQuizId) {
        alert("Generation succeeded but no quiz id returned.");
        setGenerating(false);
        return;
      }

      // Fetch questions from the newly created quiz
      const newQs = await fetchQuizQuestionsById(newQuizId);

      // Append to current quiz and save (total remains capped at 30 by earlier gate)
      const merged = [...(questions || []), ...(newQs || [])];
      const { error: updErr } = await supabase
        .from("quizzes")
        .update({
          title: title || baseBody.title, // keep current title
          questions: merged,
          updated_at: new Date().toISOString(),
        })
        .eq("id", quizId)
        .eq("user_id", user.id);
      if (updErr) {
        alert("Generated questions were created but couldn't be added to this quiz.");
        setGenerating(false);
        return;
      }

      // Delete the temporary quiz to avoid clutter
      await supabase.from("quizzes").delete().eq("id", newQuizId).eq("user_id", user.id);

      // Refresh UI
      await loadQuiz();
      setMsg(`Added ${newQs.length} question${newQs.length === 1 ? "" : "s"} to this quiz.`);
      setTimeout(() => setMsg(""), 1500);
      setGenOpen(false);
    } catch (e) {
      console.error(e);
      alert("Failed to generate questions. Please try again.");
    } finally {
      setGenerating(false);
    }
  }

  // ---------- mutual exclusivity helpers for file toggle ----------
  function handleChooseFileChange(e) {
    const file = e.target.files?.[0] ?? null;
    setGFile(file);
    if (file) {
      if (gKeepSavedFile) setGKeepSavedFile(false);
    }
  }
  function handleKeepSavedToggle(e) {
    const checked = e.target.checked;
    setGKeepSavedFile(checked);
    if (checked) {
      setGFile(null);
      if (fileInputRef.current) {
        try { fileInputRef.current.value = ""; } catch {}
      }
    }
  }
  function clearChosenFile() {
    setGFile(null);
    if (fileInputRef.current) {
      try { fileInputRef.current.value = ""; } catch {}
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
     <header className="border-b border-gray-800 px-6 sm:px-8 lg:px-12 py-3 sm:py-4">
  {/* --- Desktop / tablet (unchanged) --- */}
  <div className="hidden sm:grid sm:grid-cols-3 sm:items-center">
    {/* Left: page title */}
    <h1 className="text-xl font-bold justify-self-start">Edit Quiz</h1>

    {/* Center: logo */}
    <div className="flex items-center justify-center">
      <img
        src="/smartquizlogo.png"
        alt="Smart-Quiz logo"
        className="h-12 sm:h-10 md:h-16 w-auto my-2 sm:my-3 object-contain select-none pointer-events-none"
        draggable="false"
      />
    </div>

    {/* Right: actions */}
    <div className="flex items-center gap-2 justify-self-end">
      <Link to="/" className={`${btnBase} ${btnGray}`}>Back</Link>
      <button onClick={save} className={`${btnBase} ${btnGreen}`}>Save</button>
    </div>
  </div>

  {/* --- Mobile only --- */}
  <div className="sm:hidden">
    {/* Row 1: centered logo with a bit of extra bottom space */}
    <div className="flex items-center justify-center mb-3">
      <img
        src="/smartquizlogo.png"
        alt="Smart-Quiz logo"
        className="h-12 w-auto my-1 object-contain select-none pointer-events-none"
        draggable="false"
      />
    </div>
    {/* Row 2: title left, actions right */}
    <div className="flex items-center justify-between">
      <h1 className="text-xl font-bold">Edit Quiz</h1>
      <div className="flex items-center gap-2">
        <Link to="/" className={`${btnBase} ${btnGray}`}>Back</Link>
        <button onClick={save} className={`${btnBase} ${btnGreen}`}>Save</button>
      </div>
    </div>
  </div>
</header>

      <main className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
        {msg && (
          <div className="rounded-lg border border-emerald-800 bg-emerald-900/30 text-emerald-300 px-3 py-2 text-sm sm:text-base">
            {msg}
          </div>
        )}

        {/* Title + Group row */}
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.4fr)_minmax(260px,1fr)] gap-3 items-start">
          <div>
            <label className="block text-xs sm:text-sm text-gray-300 mb-1">Title</label>
            <input
              className="w-full p-3 rounded bg-white text-gray-900 border border-gray-300 placeholder:text-gray-500 text-base sm:text-lg"
              placeholder="Quiz title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <div className="mt-2">
              <button
                onClick={openRegenerateModalPrefilled}
                className={`${btnBase} ${btnGreen}`}
                title="Open Generate with AI to replace this quiz"
              >
                Edit Prompt and Regenerate with AI +
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs sm:text-sm text-gray-300 mb-1">Group</label>
            <div className="flex gap-2">
              <select
                className="w-full p-3 rounded bg-gray-800 text-white border border-gray-700 disabled:opacity-60 text-base"
                value={groupId}
                onChange={handleGroupChange}
                disabled={savingGroup}
              >
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              <button
                className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 whitespace-nowrap text-sm sm:text-base"
                onClick={() => setNewOpen(true)}
                disabled={savingGroup}
              >
                New group +
              </button>
            </div>
          </div>
        </div>

        {/* Questions list with checkboxes */}
        <div className="space-y-4">
          {questions.map((row, i) => (
            <div key={i} className="bg-gray-800 p-4 rounded-xl">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  aria-label={`Select Question ${i + 1}`}
                  className="mt-1 h-5 w-5 accent-emerald-500"
                  checked={selected.has(i)}
                  onChange={() => toggleSelect(i)}
                />
                <div className="flex-1">
                  <label className="block text-xs sm:text-sm text-gray-300 mb-1">
                    Question {i + 1}
                  </label>
                  <textarea
                    className="w-full p-3 rounded bg-white text-gray-900 border border-gray-300 placeholder:text-gray-500 mb-3 text-base sm:text-lg"
                    placeholder={`Question ${i + 1} prompt`}
                    value={row.prompt}
                    onChange={(e) => updateRow(i, "prompt", e.target.value)}
                    rows={3}
                  />
                  <label className="block text-xs sm:text-sm text-gray-300 mb-1">
                    Exact answer
                  </label>
                  <textarea
                    className="w-full p-3 rounded bg-white text-gray-900 border border-gray-300 placeholder:text-gray-500 text-base sm:text-lg"
                    placeholder="Exact correct answer"
                    value={row.answer}
                    onChange={(e) => updateRow(i, "answer", e.target.value)}
                    rows={2}
                  />
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:justify-end sm:gap-2">
                    <button
                      onClick={save}
                      className="w-full sm:w-auto px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm sm:text-base"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => removeRow(i)}
                      className="w-full sm:w-auto px-3 py-2 rounded bg-red-500 hover:bg-red-600 text-sm sm:text-base"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={addRow}
          className="w-full sm:w-auto px-4 py-2 rounded bg-gray-700 hover:bg-gray-600"
        >
          + Add Question
        </button>
      </main>

      {/* Sticky delete-selected button (only when any selected) */}
      {selectedCount > 0 && (
        <div className="fixed right-4 sm:right-6 top-1/2 -translate-y-1/2 z-50">
          <button
            onClick={deleteSelected}
            className={`${btnBase} ${btnRed} shadow-lg px-4 py-3 font-semibold`}
            title="Delete selected questions"
          >
            Delete selected ({selectedCount})
          </button>
        </div>
      )}

      {/* New Group modal */}
      {newOpen && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center p-3 sm:p-4 z-50"
          onClick={() => setNewOpen(false)}
        >
          <div
            className="w-full max-w-sm bg-gray-800 text-white rounded-2xl p-5 sm:p-6 shadow-xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (creatingGroup) return;
              if (e.key === "Enter" && newName.trim()) {
                e.preventDefault();
                createGroup();
              }
              if (e.key === "Escape") setNewOpen(false);
            }}
            tabIndex={0}
          >
            <h2 className="text-lg sm:text-xl font-bold mb-3">Create new group</h2>
            <input
              className="w-full p-3 rounded bg-gray-900 text-white border border-gray-700 mb-4"
              placeholder="Group name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
            <div className="flex flex-col sm:flex-row justify-end gap-2">
              <button
                className="w-full sm:w-auto px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
                onClick={() => setNewOpen(false)}
                disabled={creatingGroup}
              >
                Cancel
              </button>
              <button
                className="w-full sm:w-auto px-3 py-2 rounded bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60"
                onClick={createGroup}
                disabled={creatingGroup || !newName.trim()}
              >
                {creatingGroup ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Empty-group cleanup modal */}
      {cleanupOpen && cleanupGroup && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center p-3 sm:p-4 z-[60]"
          onClick={() => !cleaning && setCleanupOpen(false)}
        >
          <div
            className="w-full max-w-md bg-gray-800 text-white rounded-2xl p-5 sm:p-6 shadow-xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2">Delete empty group?</h2>
            <p className="text-gray-300 mb-6">
              The group <span className="font-semibold">{cleanupGroup.name}</span> no longer has any
              quizzes. Would you like to delete this group?
            </p>
            <div className="flex flex-col sm:flex-row justify-end gap-2">
              <button
                className="w-full sm:w-auto px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
                onClick={() => setCleanupOpen(false)}
                disabled={cleaning}
              >
                Keep group
              </button>
              <button
                className="w-full sm:w-auto px-3 py-2 rounded bg-red-500 hover:bg-red-600 disabled:opacity-60"
                onClick={deleteEmptyGroupNow}
                disabled={cleaning}
              >
                {cleaning ? "Deleting…" : "Delete group"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Generate with AI (Regenerate) modal */}
      {genOpen && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-[62]"
          aria-modal="true"
          role="dialog"
          onClick={() => !generating && setGenOpen(false)}
        >
          <div
            className="w-full max-w-xl bg-gray-800 text-white rounded-2xl p-6 shadow-xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-4">Generate with AI</h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-sm text-gray-300 mb-1" htmlFor="gen-title">
                  Name
                </label>
                <input
                  id="gen-title"
                  className="w-full p-3 rounded bg-white text-gray-900 border border-gray-300 placeholder:text-gray-500"
                  placeholder="Quiz name"
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
                  className="w-full min-h-[8rem] p-3 rounded bg-white text-gray-900 border border-gray-300 placeholder:text-gray-500 resize-y"
                  placeholder="Describe what to generate…"
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

              {/* Optional source file */}
              <div className="sm:col-span-2">
                <label className="block text-sm text-gray-300 mb-1" htmlFor="gen-file">
                  Optional document to use as source (PDF / TXT / MD)
                </label>

                {/* Previously used file (if known) */}
                {savedFileId && (
                  <div className="mb-2 text-sm text-gray-300">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={gKeepSavedFile}
                        onChange={handleKeepSavedToggle}
                      />
                      <span>
                        Keep previously used file
                        {savedFileName ? (
                          <>: <span className="font-semibold">{savedFileName}</span></>
                        ) : null}
                      </span>
                    </label>
                    {!savedFileName && (
                      <div className="mt-1 text-xs text-gray-400">
                        (previous file id: {String(savedFileId).slice(0, 8)}…)
                      </div>
                    )}
                  </div>
                )}

                <input
                  id="gen-file"
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
                  className="w-full p-3 rounded bg-gray-800 text-white border border-gray-700"
                  onChange={handleChooseFileChange}
                />

                {gFile && (
                  <div className="mt-1 text-xs text-gray-300">
                    Selected: {gFile.name}{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={clearChosenFile}
                    >
                      Clear
                    </button>
                  </div>
                )}

                {gFile && gKeepSavedFile && savedFileId && (
                  <p className="mt-1 text-xs text-amber-300">
                    A new file is selected; the previously used file will be ignored.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm text-gray-300 mb-1" htmlFor="gen-group">
                  Add to Group
                </label>
                <select
                  id="gen-group"
                  className="w-full p-3 rounded bg-gray-900 text-white border border-gray-700"
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
              </div>

              <div>
                <label className="block text-sm text-gray-300 mb-1" htmlFor="gen-count">
                  {isAdd ? "# of questions to add" : "# of questions"}
                </label>
                <input
                  id="gen-count"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  // max is enforced manually to allow custom add cap; keep 999 here to not block typing
                  max={999}
                  className="w-full p-3 rounded bg-gray-900 text-white border border-gray-700"
                  value={gCountStr}
                  onChange={handleCountChange}
                  onBlur={handleCountBlur}
                />
                {isAdd && (
                  <div className="mt-1 text-xs text-gray-400">
                    Current questions: {currentCount} • Max total: {MAX_TOTAL} • You can add up to {maxAdd}.
                  </div>
                )}
              </div>

              {/* Mode toggles (mutually exclusive) */}
              <div className="sm:col-span-2 mt-2 border-t border-gray-700 pt-3">
                <div className="flex flex-col gap-2">
                  <label className="inline-flex items-center gap-2 text-sm text-gray-200">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={gMode === "add"}
                      onChange={chooseAdd}
                    />
                    <span>Add to existing questions</span>
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm text-gray-200">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={gMode === "replace"}
                      onChange={chooseReplace}
                    />
                    <span>Replace all questions</span>
                  </label>
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
                onClick={regenerateFromModal}
                disabled={generating}
              >
                {generating ? "Working…" : "Regenerate"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
