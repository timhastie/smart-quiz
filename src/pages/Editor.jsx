// src/pages/Editor.jsx
import { useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

export default function Editor() {
  const { user } = useAuth();
  const { quizId } = useParams();

  const [title, setTitle] = useState("");
  const [questions, setQuestions] = useState([]);
  const [msg, setMsg] = useState("");

  // Groups
  const [groups, setGroups] = useState([]);     // [{id, name}]
  const [groupId, setGroupId] = useState("");   // "" = No group in the UI
  const [savingGroup, setSavingGroup] = useState(false);

  // Track previous group id to know which to check after change
  const prevGroupRef = useRef(null);

  // New group modal
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);

  // Empty-group cleanup modal (after moving out of a group)
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupGroup, setCleanupGroup] = useState(null); // { id, name }
  const [cleaning, setCleaning] = useState(false);

  async function loadGroups() {
    const { data, error } = await supabase
      .from("groups")
      .select("id, name")
      .eq("user_id", user.id)
      .order("name", { ascending: true });
    if (!error) setGroups(data ?? []);
  }

  useEffect(() => {
    (async () => {
      await loadGroups();

      const { data, error } = await supabase
        .from("quizzes")
        .select("title, questions, group_id")
        .eq("id", quizId)
        .eq("user_id", user.id)
        .single();

      if (!error && data) {
        setTitle(data.title || "");
        setQuestions(data.questions || []);
        const gid = data.group_id || "";
        setGroupId(gid);
        prevGroupRef.current = gid || null;
      }
    })();
  }, [quizId, user.id]);

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
        updated_at: new Date().toISOString(),
      })
      .eq("id", quizId)
      .eq("user_id", user.id);

    if (!error) {
      setMsg("Saved!");
      setTimeout(() => setMsg(""), 1500);
    }
  }

  // Check if a group is now empty; if yes → prompt to delete it
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

  // Auto-save when group selection changes; then check if the old group is empty
  async function handleGroupChange(e) {
    const next = e.target.value; // "" or a real group id
    const prev = prevGroupRef.current; // might be null or string

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
        // after saving, if previous group exists and is different, check emptiness
        if (prev && prev !== (next || null)) {
          // tiny delay so DB finishes the write
          setTimeout(() => {
            maybePromptDeleteEmptyGroup(prev);
          }, 0);
        }
        prevGroupRef.current = next || null;
      } else {
        alert("Failed to save group. Please try again.");
      }
    } finally {
      setSavingGroup(false);
    }
  }

  // Create a new group and immediately assign this quiz to it
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

      // Save new group selection + check previous group emptiness
      const prev = prevGroupRef.current;
      setGroupId(data.id);

      const { error: linkErr } = await supabase
        .from("quizzes")
        .update({ group_id: data.id, updated_at: new Date().toISOString() })
        .eq("id", quizId)
        .eq("user_id", user.id);

      if (!linkErr) {
        if (prev && prev !== data.id) {
          setTimeout(() => {
            maybePromptDeleteEmptyGroup(prev);
          }, 0);
        }
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
          <div className="md:col-span-2">
            <label className="block text-xs sm:text-sm text-gray-300 mb-1">Title</label>
            <input
              className="w-full p-3 rounded bg-white text-gray-900 border border-gray-300 placeholder:text-gray-500 text-base sm:text-lg"
              placeholder="Quiz title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
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
    </div>
  );
}
