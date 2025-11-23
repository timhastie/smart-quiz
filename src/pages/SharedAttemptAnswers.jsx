import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

export default function SharedAttemptAnswers() {
    const { quizId, attemptId } = useParams();
    const { user, ready } = useAuth();

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(null);
    const [answers, setAnswers] = useState([]);
    const [quizTitle, setQuizTitle] = useState("");

    const pressAnim = "transition-all duration-150 active:scale-[0.97]";
    const btnBase =
        "btn-sentence px-4 py-2 rounded-2xl font-semibold tracking-tight disabled:opacity-50 disabled:cursor-not-allowed";
    const btnGray = `bg-white/10 hover:bg-white/20 text-white ${pressAnim}`;

    useEffect(() => {
        if (!ready) return;
        if (!user?.id || !quizId || !attemptId) return;

        let cancelled = false;

        async function load() {
            setLoading(true);
            setError("");

            try {
                // 1) Verify ownership & get quiz title
                const { data: quizRow, error: quizErr } = await supabase
                    .from("quizzes")
                    .select("title")
                    .eq("id", quizId)
                    .eq("user_id", user.id)
                    .single();

                if (quizErr || !quizRow) {
                    if (!cancelled) setError("Quiz not found or access denied.");
                    setLoading(false);
                    return;
                }
                if (!cancelled) setQuizTitle(quizRow.title || "Untitled Quiz");

                // 2) Fetch attempt details
                const { data: attRow, error: attErr } = await supabase
                    .from("quiz_share_attempts")
                    .select("participant_name, attempt_number, score, created_at")
                    .eq("id", attemptId)
                    .eq("quiz_id", quizId) // extra safety
                    .single();

                if (attErr || !attRow) {
                    if (!cancelled) setError("Attempt not found.");
                    setLoading(false);
                    return;
                }
                if (!cancelled) setAttempt(attRow);

                // 3) Fetch answers
                const { data: ansRows, error: ansErr } = await supabase
                    .from("quiz_share_answers")
                    .select("*")
                    .eq("attempt_id", attemptId)
                    .order("question_index", { ascending: true });

                if (ansErr) {
                    console.error("Error fetching answers:", ansErr);
                    // Not fatal, just show empty
                }
                if (!cancelled) setAnswers(ansRows || []);
            } catch (e) {
                console.error(e);
                if (!cancelled) setError("Failed to load details.");
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        load();
        return () => {
            cancelled = true;
        };
    }, [ready, user?.id, quizId, attemptId]);

    if (loading || !ready) {
        return (
            <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
                <div className="surface-card px-6 py-4 rounded-3xl text-center">
                    <p className="text-sm text-white/70">Loading details…</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
                <div className="surface-card max-w-md w-full px-6 py-5 rounded-3xl space-y-4 text-center">
                    <h1 className="text-xl font-semibold">Error</h1>
                    <p className="text-sm text-white/70">{error}</p>
                    <div className="flex justify-center">
                        <Link to={`/scores/${quizId}`} className={`${btnBase} ${btnGray}`}>
                            Back to Scoreboard
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 pb-12">
            <header className="sticky top-0 z-40 border-b border-white/5 bg-slate-950/80 backdrop-blur-md">
                <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-between gap-4 px-6 py-4">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="text-left min-w-0">
                            <p className="text-xs uppercase tracking-[0.2em] text-white/60">
                                Attempt Details
                            </p>
                            <h1 className="text-xl font-semibold tracking-tight truncate">
                                {quizTitle}
                            </h1>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <Link to={`/scores/${quizId}`} className={`${btnBase} ${btnGray} text-sm`}>
                            Back
                        </Link>
                        <Link to="/" className={`${btnBase} ${btnGray} text-sm`}>
                            Home
                        </Link>
                    </div>
                </div>
            </header>

            <main className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 space-y-6">
                {/* Summary Card */}
                <div className="surface-card p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                        <h2 className="text-lg font-semibold text-white">
                            {attempt.participant_name || "Unnamed Participant"}
                        </h2>
                        <p className="text-sm text-white/60">
                            Attempt #{attempt.attempt_number} •{" "}
                            {new Date(attempt.created_at).toLocaleString()}
                        </p>
                    </div>
                    <div className="text-right">
                        <div className="text-sm text-white/60 uppercase tracking-wide">
                            Score
                        </div>
                        <div
                            className={`text-3xl font-bold ${attempt.score >= 90 ? "text-emerald-400" : "text-white"
                                }`}
                        >
                            {attempt.score}%
                        </div>
                    </div>
                </div>

                {/* Answers List */}
                <div className="space-y-4">
                    {answers.length === 0 ? (
                        <div className="text-center text-white/50 py-8 italic">
                            No detailed answers recorded for this attempt.
                        </div>
                    ) : (
                        answers.map((ans, i) => (
                            <div key={ans.id || i} className="surface-panel p-5 space-y-3">
                                <div className="flex items-start gap-3">
                                    <div className="flex-none pt-1">
                                        <span className="text-xs font-bold text-white/40 uppercase tracking-wider">
                                            Q{ans.question_index + 1}
                                        </span>
                                    </div>
                                    <div className="flex-1 space-y-3">
                                        <p className="text-base sm:text-lg font-medium text-white/90">
                                            {ans.question_text || "(No question text)"}
                                        </p>

                                        <div className="space-y-2">
                                            <div
                                                className={`p-3 rounded-lg border ${ans.is_correct
                                                    ? "bg-emerald-500/10 border-emerald-500/30"
                                                    : "bg-rose-500/10 border-rose-500/30"
                                                    }`}
                                            >
                                                <p className="text-xs uppercase tracking-wide opacity-70 mb-1">
                                                    Participant Answer
                                                </p>
                                                <div className="flex items-start gap-2">
                                                    {ans.is_correct ? (
                                                        <span className="text-emerald-400 text-lg">✓</span>
                                                    ) : (
                                                        <span className="text-rose-400 text-lg">✕</span>
                                                    )}
                                                    <p className="text-white/90 whitespace-pre-wrap">
                                                        {ans.user_answer || "(Empty)"}
                                                    </p>
                                                </div>
                                            </div>

                                            {!ans.is_correct && (
                                                <div className="p-3 rounded-lg bg-white/5 border border-white/10">
                                                    <p className="text-xs uppercase tracking-wide opacity-50 mb-1">
                                                        Correct Answer
                                                    </p>
                                                    <p className="text-white/80 whitespace-pre-wrap">
                                                        {ans.correct_answer || "(No correct answer stored)"}
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </main>
        </div>
    );
}
