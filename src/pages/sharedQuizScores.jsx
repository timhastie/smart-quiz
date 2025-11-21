// src/pages/sharedQuizScores.jsx
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronsUpDown } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

export default function SharedQuizScores() {
  const { quizId } = useParams();
  const { user, ready } = useAuth();

  const pressAnim = "transition-all duration-150 active:scale-[0.97]";
  const btnBase =
    "btn-sentence px-4 py-2 rounded-2xl font-semibold tracking-tight disabled:opacity-50 disabled:cursor-not-allowed";
  const btnGray = `bg-white/10 hover:bg-white/20 text-white ${pressAnim}`;
  const btnGreen = `bg-emerald-500/90 hover:bg-emerald-400 text-slate-950 ${pressAnim}`;
  const btnRed = `bg-rose-600/80 hover:bg-rose-500 text-white ${pressAnim}`;

  const [loading, setLoading] = useState(true);
  const [quiz, setQuiz] = useState(null);
  const [attempts, setAttempts] = useState([]);
  const [error, setError] = useState("");
  const [selectedAttempts, setSelectedAttempts] = useState({});
  const [deletingName, setDeletingName] = useState(null);
  const [purging, setPurging] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);

  useEffect(() => {
    if (!ready) return;
    if (!user?.id || !quizId) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");

      // 1) Make sure this quiz belongs to the logged-in user
      const { data: quizRow, error: quizErr } = await supabase
        .from("quizzes")
        .select("id, title")
        .eq("id", quizId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (quizErr || !quizRow) {
        if (!cancelled) {
          setError("Quiz not found, or you are not the owner.");
          setQuiz(null);
          setAttempts([]);
          setLoading(false);
        }
        return;
      }

      // 2) Load all attempts recorded for this quiz
      const { data: attemptRows, error: attErr } = await supabase
        .from("quiz_share_attempts")
        .select("id, participant_name, attempt_number, score, created_at")
        .eq("user_id", user.id)
        .eq("quiz_id", quizId)
        .order("participant_name", { ascending: true })
        .order("attempt_number", { ascending: true });

      if (!cancelled) {
        if (attErr) {
          console.error("Error loading quiz_share_attempts:", attErr);
          setError("Failed to load scores.");
          setQuiz(quizRow);
          setAttempts([]);
        } else {
          setQuiz(quizRow);
          setAttempts(attemptRows || []);
        }
        setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [ready, user?.id, quizId]);

  const hasAttempts = attempts.length > 0;

  function escapeHtml(str) {
    return (str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const requestDeleteParticipant = (group) => {
    if (!group) return;
    setConfirmAction({ type: "participant", group });
  };

  const requestDeleteAll = () => {
    if (!hasAttempts) return;
    setConfirmAction({ type: "all" });
  };

  const groupedParticipants = useMemo(() => {
    const byName = new Map();
    for (const row of attempts) {
      const trimmed = (row?.participant_name || "").trim();
      const displayName = trimmed || "Unnamed";
      let entry = byName.get(displayName);
      if (!entry) {
        entry = {
          name: displayName,
          isUnnamed: !trimmed,
          rows: [],
        };
        byName.set(displayName, entry);
      }
      entry.rows.push(row);
    }
    const arr = Array.from(byName.values());
    arr.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of arr) {
      entry.rows.sort((a, b) => {
        const numDiff = (a.attempt_number ?? 0) - (b.attempt_number ?? 0);
        if (numDiff !== 0) return numDiff;
        return new Date(a.created_at || 0) - new Date(b.created_at || 0);
      });
    }
    return arr;
  }, [attempts]);

  useEffect(() => {
    setSelectedAttempts((prev) => {
      let changed = false;
      const next = { ...prev };
      const validNames = new Set();

      for (const group of groupedParticipants) {
        validNames.add(group.name);
        const currentId = next[group.name];
        const hasCurrent = group.rows.some((row) => row.id === currentId);
        if (!hasCurrent) {
          const fallback = group.rows[group.rows.length - 1]?.id;
          if (fallback) {
            next[group.name] = fallback;
          } else {
            delete next[group.name];
          }
          changed = true;
        }
      }

      for (const key of Object.keys(next)) {
        if (!validNames.has(key)) {
          delete next[key];
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [groupedParticipants]);

  async function deleteParticipant(group) {
    if (!user?.id || !quizId) return;
    if (!group?.rows?.length) return;
    try {
      setDeletingName(group.name);
      const ids = group.rows.map((row) => row.id);
      const { error: delErr } = await supabase
        .from("quiz_share_attempts")
        .delete()
        .eq("user_id", user.id)
        .eq("quiz_id", quizId)
        .in("id", ids);

      if (delErr) {
        console.error("Failed to delete attempts:", delErr);
        alert("Could not delete these attempts. Please try again.");
        return;
      }

      setAttempts((prev) => prev.filter((row) => !ids.includes(row.id)));
    } finally {
      setDeletingName(null);
    }
  }

  async function deleteAllParticipants() {
    if (!user?.id || !quizId) return;
    if (!hasAttempts) return;
    try {
      setPurging(true);
      const { error: delErr } = await supabase
        .from("quiz_share_attempts")
        .delete()
        .eq("user_id", user.id)
        .eq("quiz_id", quizId);

      if (delErr) {
        console.error("Failed to delete all attempts:", delErr);
        alert("Could not delete all entries. Please try again.");
        return;
      }

      setAttempts([]);
    } finally {
      setPurging(false);
    }
  }

  function handlePrintScores() {
    if (!hasAttempts) return;
    const sections = groupedParticipants
      .map((group) => {
        const rows = group.rows
          .map((row) => {
            const attemptLabel =
              row.attempt_number != null ? row.attempt_number : "—";
            const dateLabel = row.created_at
              ? new Date(row.created_at).toLocaleString()
              : "—";
            const scoreLabel =
              typeof row.score === "number" ? `${row.score}%` : "—";
            return `<li>
  <strong>Attempt ${escapeHtml(String(attemptLabel))}</strong> — Score: ${escapeHtml(
              scoreLabel
            )} • Date: ${escapeHtml(dateLabel)}
</li>`;
          })
          .join("\n");
        return `<section class="qa-block">
  <p><strong>Participant:</strong> ${group.isUnnamed ? "<em>Unnamed</em>" : escapeHtml(group.name)}</p>
  <ul>
    ${rows}
  </ul>
</section>`;
      })
      .join("\n<hr />\n");

    const docTitle = `Shared Scores — ${quiz?.title || "Quiz"}`;
    const printWindow = window.open("", "_blank", "width=900,height=700");
    if (!printWindow) {
      alert("Please allow pop-ups to print these scores.");
      return;
    }
    printWindow.document.write(`<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(docTitle)}</title>
    <style>
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 32px;
        line-height: 1.6;
        color: #0f172a;
      }
      h1 {
        margin-top: 0;
        font-size: 1.5rem;
      }
      hr {
        border: none;
        border-top: 1px solid #cbd5f5;
        margin: 24px 0;
      }
      .qa-block p {
        margin: 0 0 8px;
      }
      .qa-block ul {
        padding-left: 1.2rem;
        margin: 0 0 8px;
      }
      .qa-block li {
        margin-bottom: 4px;
      }
      .qa-block strong {
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(docTitle)}</h1>
    ${sections}
  </body>
</html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 border-b border-white/5 bg-slate-950/80 backdrop-blur-md">
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
                Shared Scores
              </p>
              <h1 className="text-2xl font-semibold tracking-tight truncate">
                {quiz ? quiz.title || "Untitled Quiz" : "Quiz Scores"}
              </h1>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 text-sm flex-none">
            <Link
              to="/"
              className={`${btnBase} ${btnGray}`}
              title="Back to dashboard"
            >
              Back
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 pt-6 pb-12">
        {loading || !ready ? (
          <div className="surface-card p-6 text-center text-white/70">
            Loading scores…
          </div>
        ) : error ? (
          <div className="surface-card p-6 text-center text-red-400">
            {error}
          </div>
        ) : !hasAttempts ? (
          <div className="surface-card p-6 text-center text-white/70">
            No one has completed this quiz yet.
          </div>
        ) : (
          <section className="surface-card p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">
                  Scoreboard
                </h2>
                <p className="text-sm text-white/70">
                  Each row shows a participant. If they tried multiple times,
                  use the dropdown to view a specific attempt.
                </p>
              </div>
              <div className="text-sm text-white/60">
                Total attempts:{" "}
                <span className="font-semibold text-white">
                  {attempts.length}
                </span>
              </div>
            </div>

            <div className="overflow-x-auto mt-2">
              <table className="min-w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-white/60">
                    <th className="py-2 pr-4">Participant</th>
                    <th className="py-2 pr-4">Attempt #</th>
                    <th className="py-2 pr-4">Score</th>
                    <th className="py-2 pr-4">Date</th>
                    <th className="py-2 text-right"> </th>
                  </tr>
                </thead>
                <tbody>
                  {groupedParticipants.map((group) => {
                    const defaultId = group.rows[group.rows.length - 1]?.id;
                    const activeId =
                      selectedAttempts[group.name] && group.rows.some((r) => r.id === selectedAttempts[group.name])
                        ? selectedAttempts[group.name]
                        : defaultId;
                    const activeRow =
                      group.rows.find((row) => row.id === activeId) ||
                      group.rows[group.rows.length - 1];
                    const showSelect = group.rows.length > 1;
                    const selectValue = activeRow?.id ?? defaultId ?? "";

                    return (
                      <tr
                        key={group.name}
                        className="border-b border-white/5 last:border-b-0"
                      >
                        <td className="py-2 pr-4">
                          {group.isUnnamed ? (
                            <span className="italic text-white/60">
                              {group.name}
                            </span>
                          ) : (
                            group.name
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          {showSelect ? (
                            <div className="relative inline-block min-w-[88px]">
                              <select
                                className="appearance-none bg-slate-900/60 border border-white/10 rounded-xl pl-3 pr-8 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent w-full text-white"
                                value={selectValue}
                                onChange={(e) =>
                                  setSelectedAttempts((prev) => ({
                                    ...prev,
                                    [group.name]: e.target.value,
                                  }))
                                }
                              >
                                {group.rows.map((row) => (
                                  <option key={row.id} value={row.id}>
                                    {row.attempt_number}
                                  </option>
                                ))}
                              </select>
                              <ChevronsUpDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-white/60" />
                            </div>
                          ) : (
                            group.rows[0]?.attempt_number ?? "—"
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          {activeRow ? (
                            <span
                              className={
                                activeRow.score >= 90
                                  ? "text-green-400 font-semibold"
                                  : "text-white"
                              }
                            >
                              {activeRow.score}%
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-2 pr-4 text-white/70">
                          {activeRow?.created_at
                            ? new Date(activeRow.created_at).toLocaleString()
                            : "—"}
                        </td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            className="text-white/50 hover:text-red-400 transition-colors disabled:opacity-40"
                            aria-label={`Delete all attempts for ${group.name}`}
                            onClick={() => requestDeleteParticipant(group)}
                            disabled={deletingName === group.name}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={requestDeleteAll}
                className="text-sm text-white/60 hover:text-red-400 transition-colors flex items-center gap-2 disabled:opacity-40"
                disabled={purging}
                title="Delete all scoreboard entries"
              >
                <span className="text-lg leading-none">×</span>
                <span>Delete entire scoreboard</span>
              </button>
            </div>
          </section>
        )}

        {hasAttempts ? <div className="h-16" aria-hidden /> : null}
      </main>

      {hasAttempts ? (
        <footer className="sticky bottom-0 z-30 bg-slate-950/90 backdrop-blur-md border-t border-white/5 px-4 sm:px-6 py-4">
          <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={handlePrintScores}
              className={`${btnBase} ${btnGray} h-12 px-6`}
            >
              Print
            </button>
          </div>
        </footer>
      ) : null}

      {confirmAction && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center px-4">
          <div className="surface-card w-full max-w-md p-6 space-y-4">
            <h3 className="text-xl font-semibold">
              {confirmAction.type === "participant"
                ? "Delete participant attempts?"
                : "Delete entire scoreboard?"}
            </h3>
            <p className="text-white/70 text-sm">
              {confirmAction.type === "participant"
                ? `This will remove every attempt recorded for "${confirmAction.group?.name}". This action cannot be undone.`
                : "This will remove every scoreboard entry for this quiz. This action cannot be undone."}
            </p>
            <div className="flex flex-col sm:flex-row gap-2 justify-end">
              <button
                type="button"
                className={`${btnBase} ${btnGray}`}
                onClick={() => setConfirmAction(null)}
                disabled={purging || deletingName}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`${btnBase} ${btnRed}`}
                onClick={async () => {
                  if (confirmAction.type === "participant") {
                    await deleteParticipant(confirmAction.group);
                  } else {
                    await deleteAllParticipants();
                  }
                  setConfirmAction(null);
                }}
                disabled={purging || deletingName}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
