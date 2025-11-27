// supabase/functions/generate-quiz/index.ts
// CORS-enabled generate-quiz with novelty controls (semantic de-dup),
// optional in-place regeneration, and RAG retrieval from file_chunks via RPC `match_file_chunks`

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import OpenAI from "npm:openai@4.56.0";
import { createClient } from "npm:@supabase/supabase-js@2";

// ---- Lazy OpenAI so module load never crashes if secret is missing ----
let _openai: OpenAI | null = null;
function getOpenAI() {
  if (_openai) return _openai;
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("Missing OPENAI_API_KEY");
  _openai = new OpenAI({ apiKey: key });
  return _openai;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // tighten for prod
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
function text(body: string, status = 200) {
  return new Response(body, { status, headers: { ...corsHeaders } });
}

type QA = { prompt: string; answer: string };

// ---------- light exact/lexical helpers (kept for cheap first-pass) ----------
function normalize(s: string) {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}
const STOP = new Set([
  "the", "a", "an", "to", "of", "in", "on", "at", "for", "with", "and", "or", "is", "are", "be", "this", "that", "these", "those", "as", "by", "from", "into", "over", "under", "up", "down", "all",
]);
function tokenize(s: string) {
  return normalize(s)
    .split(" ")
    .filter((w) => w && !STOP.has(w));
}
function jaccard(a: string, b: string) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

// ---------- SEMANTIC de-dup (embeddings) ----------
async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await getOpenAI().embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });
  return res.data.map((d) => d.embedding as unknown as number[]);
}
function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

/**
 * Filters out paraphrases vs prior content and enforces diversity within the batch.
 *  - SIM_TO_AVOID: reject if too similar to any prior/avoid prompt
 *  - SIM_WITHIN_BATCH: keep batch varied
 * Also runs a fast exact/lexical pass first.
 */
async function filterSemanticallyNovel(
  candidates: QA[],
  avoid_prompts: string[],
  SIM_TO_AVOID = 0.86,
  SIM_WITHIN_BATCH = 0.80
): Promise<QA[]> {
  if (candidates.length === 0) return [];

  // 0) Normalize & cap avoid list to keep costs small
  const seen = new Set<string>();
  const cleanedAvoid: string[] = [];
  for (const p of avoid_prompts || []) {
    const t = (p || "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); cleanedAvoid.push(t); }
    if (cleanedAvoid.length >= 500) break;
  }

  // 1) Quick exact/lexical pass against avoid list
  const avoidExact = new Set(cleanedAvoid.map((p) => normalize(p)));
  let firstPass = candidates.filter((qa) => {
    const nm = normalize(qa.prompt);
    if (avoidExact.has(nm)) return false;                 // exact/near-exact
    for (const p of cleanedAvoid) {
      if (jaccard(qa.prompt, p) >= 0.90) return false;    // high lexical overlap
    }
    return true;
  });
  if (firstPass.length === 0) return [];

  // 2) Semantic pass vs avoid list
  const [avoidEmb, candEmb] = await Promise.all([
    embedBatch(cleanedAvoid),
    embedBatch(firstPass.map((c) => c.prompt)),
  ]);
  const keepIndexes: number[] = [];
  candEmb.forEach((emb, idx) => {
    if (!emb) return;
    let clash = false;
    for (const aEmb of avoidEmb) {
      if (cosine(emb, aEmb) >= SIM_TO_AVOID) { clash = true; break; }
    }
    if (!clash) keepIndexes.push(idx);
  });
  if (keepIndexes.length === 0) return [];

  // 3) Enforce diversity inside the kept batch (greedy)
  const filtered: QA[] = [];
  const chosenEmb: number[][] = [];
  for (const i of keepIndexes) {
    const e = candEmb[i];
    let ok = true;
    for (const ce of chosenEmb) {
      if (cosine(e, ce) >= SIM_WITHIN_BATCH) { ok = false; break; }
    }
    if (ok) {
      filtered.push(firstPass[i]);
      chosenEmb.push(e);
    }
  }
  return filtered;
}

// --- RAG: fetch top-k chunks via RPC (safe fallback to empty on error) ---
async function fetchTopChunks(opts: {
  supa: ReturnType<typeof createClient>;
  userId: string;
  fileId: string;
  topic: string;
  title: string;
  n: number;
  k?: number;
}): Promise<string[]> {
  const { supa, userId, fileId, topic, title, n, k = 15 } = opts;
  const queryText = `Generate ${n} quiz questions about: ${topic || title || "the uploaded document"}`;

  const emb = await getOpenAI().embeddings.create({
    model: "text-embedding-3-small",
    input: queryText,
  });
  const vec = emb.data[0].embedding as unknown as number[];

  try {
    const { data, error } = await supa.rpc("match_file_chunks", {
      p_user_id: userId,
      p_file_id: fileId,
      p_query_embedding: vec,
      p_match_count: k,
    });
    if (error || !data?.length) return [];
    return data.map((r: any) => String(r.content || "")).filter(Boolean);
  } catch {
    return [];
  }
}

// Try to resolve a human-readable file name from file_chunks when client didn't pass one
async function resolveFileName(
  supa: ReturnType<typeof createClient>,
  userId: string,
  fileId: string | null | undefined,
  providedName?: string | null
): Promise<string | null> {
  if (providedName && providedName.trim()) return providedName.trim();
  if (!fileId) return null;
  const { data } = await supa
    .from("file_chunks")
    .select("file_name")
    .eq("user_id", userId)
    .eq("file_id", fileId)
    .limit(1)
    .maybeSingle();
  return (data?.file_name && String(data.file_name)) || null;
}

async function llmGenerate(
  n: number,
  prompt: string,
  priorPromptsForContext: string[],
  docContext: string
): Promise<QA[]> {
  const sys = `You generate quiz questions.
Return ONLY a JSON array of objects with keys "prompt" and "answer".
No markdown, no code fences, no commentary.
Avoid paraphrasing prior items; prefer NEW subtopics, different entities/times/angles.`;

  const priorSlice = priorPromptsForContext.slice(0, 200);
  const priorText =
    priorSlice.length > 0
      ? `Here are prior prompts (do NOT ask about the same fact/entity even if reworded):\n${JSON.stringify(
        priorSlice
      )}`
      : "";

  const docText = docContext
    ? `\nUse ONLY the following document excerpts as your source material.\n---DOC CONTEXT START---\n${docContext}\n---DOC CONTEXT END---\n`
    : "";

  const userMsg =
    `Create ${n} question/answer pairs about: ${prompt}\n` +
    `Vary difficulty and subtopics. Answers must be concise exact strings.\n` +
    `Example element: { "prompt": "Print dog", "answer": "print('dog')" }\n\n` +
    priorText +
    docText;

  const resp = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userMsg },
    ],
  });

  const raw = resp.choices[0].message?.content?.trim() ?? "[]";
  const jsonText = raw.replace(/^```json\s*|\s*```$/g, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("Model did not return valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("Invalid JSON shape.");

  const cleaned = (parsed as any[])
    .slice(0, n)
    .map((q) => ({
      prompt: String(q?.prompt ?? "").slice(0, 500),
      answer: String(q?.answer ?? "").slice(0, 500),
    }))
    .filter((q) => q.prompt && q.answer);

  return cleaned;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") return text("Method not allowed", 405);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supa = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });

    // Auth
    const { data: userRes, error: userErr } = await supa.auth.getUser();
    if (userErr || !userRes?.user) return text("Unauthorized", 401);
    const user = userRes.user;

    // Body
    const {
      title,
      topic,
      count,
      group_id,
      file_id,
      replace_quiz_id,       // update existing quiz instead of inserting
      no_repeat,             // optional toggle (default true)
      avoid_prompts,         // extra prior prompts from client
      source_prompt,         // optional: prompt to persist (usually equals topic)
      source_file_name,      // optional: human-readable file name to persist
      source_type,           // optional: 'document' | 'youtube'
      ai_grading,            // optional: boolean (smart grading)
    } = await req.json();

    const n = Math.max(1, Math.min(Number(count) || 10, 30));
    const safeTitle = String(title || "Generated Quiz").slice(0, 120);
    const prompt = String(topic || "Create programming quiz questions.").slice(0, 2000);
    const wantNoRepeat = no_repeat !== false; // default = true
    const wantAiGrading = !!ai_grading;

    // Fast trial-cap precheck only if we are INSERTING a new quiz
    // Fast trial-cap precheck only if we are INSERTING a new quiz
    const isAnon =
      user?.app_metadata?.provider === "anonymous" ||
      user?.user_metadata?.is_anonymous === true ||
      (Array.isArray(user?.identities) &&
        user.identities.some((i: any) => i?.provider === "anonymous"));

    if (!replace_quiz_id) {
      if (isAnon) {
        const { count: quizCount, error: cErr } = await supa
          .from("quizzes")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id);
        if (!cErr && (quizCount ?? 0) >= 2) {
          return text(
            "Free trial limit reached. Create an account to make more quizzes.",
            403
          );
        }
      }
    }

    // --- RATE LIMITING ---
    // Anon: Limit by IP (5/hour) to prevent mass account creation attacks.
    // Auth: Limit by User ID (20/hour) to prevent compromised account abuse.

    const LIMIT = isAnon ? 5 : 20;
    const WINDOW_MS = 60 * 60 * 1000; // 1 hour

    let rateKey = "";
    if (isAnon) {
      rateKey = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      // If we can't determine IP, we might want to fail open or closed. 
      // For now, "unknown" buckets them all together (risky but safe for dev).
    } else {
      rateKey = user.id;
    }

    if (rateKey !== "unknown") {
      const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const admin = createClient(supabaseUrl, SERVICE_ROLE);

      const { data: usage } = await admin
        .from("rate_limits")
        .select("*")
        .eq("key", rateKey)
        .eq("endpoint", "generate-quiz")
        .single();

      const now = Date.now();
      let newCount = 1;
      let newStart = new Date().toISOString();

      if (usage) {
        const start = new Date(usage.window_start).getTime();
        if (now - start < WINDOW_MS) {
          if (usage.count >= LIMIT) {
            return text("Rate limit exceeded. Please try again later.", 429);
          }
          newCount = usage.count + 1;
          newStart = usage.window_start; // keep old window
        }
      }

      await admin.from("rate_limits").upsert({
        key: rateKey,
        endpoint: "generate-quiz",
        count: newCount,
        window_start: newStart
      });
    }


    if (!group_id || typeof group_id !== "string") {
      return text("group_id is required", 400);
    }
    const { data: g, error: gErr } = await supa
      .from("groups")
      .select("id")
      .eq("id", group_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (gErr || !g?.id) {
      return text("Invalid group_id", 400);
    }
    const targetGroupId = g.id as string;

    // Gather prior prompts for novelty (server-side)
    let priorPrompts: string[] = [];
    if (wantNoRepeat && targetGroupId) {
      const { data: priorQs } = await supa
        .from("quizzes")
        .select("questions")
        .eq("user_id", user.id)
        .eq("group_id", targetGroupId);

      const allQA = (priorQs ?? []).flatMap((r: any) =>
        Array.isArray(r?.questions) ? r.questions : []
      );
      priorPrompts = allQA
        .map((qa: any) => String(qa?.prompt ?? "").trim())
        .filter(Boolean);
    }

    // Merge any client-provided avoid list
    if (Array.isArray(avoid_prompts) && avoid_prompts.length) {
      priorPrompts = [
        ...priorPrompts,
        ...avoid_prompts.map((p: any) => String(p || "").trim()).filter(Boolean),
      ];
      // de-dup
      const seen = new Set<string>();
      priorPrompts = priorPrompts.filter((p) => {
        const k = p.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    // RAG (optional)
    let docContext = "";
    if (file_id) {
      try {
        const chunks = await fetchTopChunks({
          supa,
          userId: user.id,
          fileId: String(file_id),
          topic: prompt,
          title: safeTitle,
          n,
          k: 15,
        });
        const joined = chunks.join("\n\n");
        docContext = joined.length > 12000 ? joined.slice(0, 12000) : joined;
      } catch {
        docContext = "";
      }
    }

    // --- Generate initial candidates
    let candidates = await llmGenerate(n, prompt, priorPrompts, docContext);

    // --- Novelty enforcement
    if (wantNoRepeat) {
      // semantic de-dup vs prior + batch-diversity
      let novel = await filterSemanticallyNovel(
        candidates,
        priorPrompts,
        0.86, // SIM_TO_AVOID
        0.80  // SIM_WITHIN_BATCH
      );

      // Refill once if short
      if (novel.length < n) {
        const need = n - novel.length;
        const expandedAvoid = [...priorPrompts, ...novel.map((x) => x.prompt)];
        const refill = await llmGenerate(
          need,
          prompt + " (add new or extended questions that are not already covered above)",
          expandedAvoid,
          docContext
        );
        const refillNovel = await filterSemanticallyNovel(
          refill,
          expandedAvoid,
          0.86,
          0.80
        );
        candidates = [...novel, ...refillNovel].slice(0, n);
      } else {
        candidates = novel.slice(0, n);
      }
    } else {
      candidates = candidates.slice(0, n);
    }

    if (candidates.length === 0) return text("No usable questions.", 400);

    const now = new Date().toISOString();
    const nameToPersist = await resolveFileName(
      supa,
      user.id,
      file_id || null,
      source_file_name ?? null
    );
    const promptToPersist = (source_prompt ?? prompt) as string;

    // UPDATE (regenerate in place)
    if (replace_quiz_id) {
      // ensure ownership
      const { data: owned, error: ownErr } = await supa
        .from("quizzes")
        .select("id")
        .eq("id", replace_quiz_id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (ownErr || !owned?.id) return text("Not found", 404);

      const { error: upErr } = await supa
        .from("quizzes")
        .update({
          title: safeTitle,
          questions: candidates,
          group_id: targetGroupId,
          file_id: file_id || null,
          source_prompt: promptToPersist,
          source_file_name: nameToPersist,
          source_type: source_type || "document",
          ai_grading: wantAiGrading,
          updated_at: now,
        })
        .eq("id", replace_quiz_id)
        .eq("user_id", user.id);

      if (upErr) {
        return text(`Failed to update quiz: ${upErr.message}`, 500);
      }
      return json(
        { id: replace_quiz_id, group_id: targetGroupId, file_id, source_file_name: nameToPersist },
        200
      );
    }

    // INSERT (new quiz)
    const { data, error } = await supa
      .from("quizzes")
      .insert({
        user_id: user.id,
        title: safeTitle,
        questions: candidates,
        group_id: targetGroupId,
        file_id: file_id || null,
        source_prompt: promptToPersist,
        source_file_name: nameToPersist,
        source_type: source_type || "document",
        ai_grading: wantAiGrading,
        created_at: now,
        updated_at: now,
      })
      .select("id, group_id, file_id, source_file_name")
      .single();

    if (error) {
      if ((error as any).code === "42501") {
        return text("Free trial limit reached. Create an account to make more quizzes.", 403);
      }
      return text(`Failed to insert quiz: ${error.message}`, 500);
    }

    return json(
      { id: data.id, group_id: data.group_id, file_id: data.file_id, source_file_name: data.source_file_name },
      200
    );
  } catch (e: any) {
    return text(`Server error: ${e?.message ?? e}`, 500);
  }
});
