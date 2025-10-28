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
  const [gCount, setGCount] = useState(10);
  const [gGroupId, setGGroupId] = useState(""); // "" => No group
  const [gFile, setGFile] = useState(null);     // newly uploaded file (optional)
  const [gKeepSavedFile, setGKeepSavedFile] = useState(true); // keep previous file if present
  const [gNoRepeat, setGNoRepeat] = useState(true); // consistent with Dashboard

  // Ref to clear the <input type="file"> when toggling checkbox on
  const fileInputRef = useRef(null);

  // ----- UI button helpers (match Dashboard look) -----
  const pressAnim = "transition-transform duration-100 active:scale-95";
  const btnBase = "px-3 py-2 rounded disabled:opacity-60 disabled:cursor-not-allowed";
  const btnGray = `bg-gray-700 hover:bg-gray-600 ${pressAnim}`;
  const btnGreen = `bg-emerald-500 hover:bg-emerald-600 font-semibold ${pressAnim}`;
  const btnRed = `bg-red-500 hover:bg-red-600 ${pressAnim}`;

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
    setGCount(Math.max(1, Math.min(questions?.length || 10, 30)));
    setGGroupId(groupId || "");
    setGNoRepeat(true);
    setGFile(null);
    setGKeepSavedFile(!!savedFileId);
    setGenOpen(true);
  }

  // ---------- call Edge Function to replace this quiz ----------
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

      const count = Math.max(1, Math.min(Number(gCount) || 10, 30));
      const body = {
        title: (gTitle || "").trim() || "Untitled Quiz",
        topic: (gTopic || "").trim() || "Create a short quiz.",
        count,
        group_id: gGroupId || null,
        file_id,
        no_repeat: !!gNoRepeat,
        avoid_prompts: [],
        replace_quiz_id: quizId,
        source_prompt: (gTopic || "").trim() || null,
        source_file_name: gFile ? gFile.name : (gKeepSavedFile ? savedFileName : null),
      };

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-quiz`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
          },
          body: JSON.stringify(body),
        }
      );

      const raw = await res.text();
      if (!res.ok) {
        alert(`Failed to regenerate (${res.status}):\n${raw || "Unknown error"}`);
        setGenerating(false);
        return;
      }

      await loadQuiz();
      setMsg("Quiz regenerated.");
      setTimeout(() => setMsg(""), 1500);
      setGenOpen(false);
    } catch (e) {
      console.error(e);
      alert("Failed to regenerate quiz. Please try again.");
    } finally {
      setGenerating(false);
    }
  }

  // ---------- mutual exclusivity helpers ----------
  function handleChooseFileChange(e) {
    const file = e.target.files?.[0] ?? null;
    setGFile(file);
    if (file) {
      // Selecting a new file disables the "keep saved" toggle
      if (gKeepSavedFile) setGKeepSavedFile(false);
    }
  }
  function handleKeepSavedToggle(e) {
    const checked = e.target.checked;
    setGKeepSavedFile(checked);
    if (checked) {
      // Re-using saved file clears any newly chosen file and resets the input
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
      <header className="flex flex-wrap items-center gap-2 justify-between p-3 sm:p-4 border-b border-gray-800">
        <h1 className="text-lg sm:text-xl font-bold">Edit Quiz</h1>
        <div className="flex w-full sm:w-auto gap-2">
          <Link
            to="/"
            className="w-full sm:w-auto px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm sm:text-base text-center"
          >
            Back
          </Link>
          <button
            onClick={save}
            className="w-full sm:w-auto px-3 py-2 rounded bg-emerald-500 hover:bg-emerald-600 font-semibold text-sm sm:text-base"
          >
            Save
          </button>
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
                Edit Prompt and Regnerate with AI +
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

        {/* Questions list */}
        <div className="space-y-4">
          {questions.map((row, i) => (
            <div key={i} className="bg-gray-800 p-4 rounded-xl">
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
          ))}
        </div>

        <button
          onClick={addRow}
          className="w-full sm:w-auto px-4 py-2 rounded bg-gray-700 hover:bg-gray-600"
        >
          + Add Question
        </button>
      </main>

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
                <label className="inline-flex items-center gap-2 text-sm text-gray-2 00">
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
                  # of questions
                </label>
                <input
                  id="gen-count"
                  type="number"
                  min={1}
                  max={30}
                  className="w-full p-3 rounded bg-gray-900 text-white border border-gray-700"
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
