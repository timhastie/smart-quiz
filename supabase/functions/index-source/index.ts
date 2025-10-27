// supabase/functions/generate-quiz/index.ts
// Deno Edge Function (Supabase) — generates quiz questions.
// Requires env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
// DB: inserts into `quizzes` with columns: id, user_id, title, questions(jsonb), group_id (nullable), file_id (nullable)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import OpenAI from "npm:openai@4.56.0";
import { createClient } from "npm:@supabase/supabase-js@2";

// ---------- CORS ----------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // tighten in prod
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

type ClientReq = {
  title?: string;
  topic?: string;
  count?: number;
  group_id?: string | null;
  file_id?: string | null;

  // NEW:
  no_repeat?: boolean;
  avoid_prompts?: string[]; // prior prompts from this group (client-built)
};

type QA = { prompt: string; answer: string };

// ---------- Utils ----------
const MAX_COUNT = 30;
const FALLBACK_TOPIC =
  "Create 10 questions that test the 10 most-used Bash commands.";

function clampCount(n: unknown) {
  const c = Math.max(1, Math.min(Number(n) || 10, MAX_COUNT));
  return c;
}
function norm(s: unknown) {
  return String(s ?? "").trim().toLowerCase();
}
function dedupeByPrompt(items: QA[]) {
  const seen = new Set<string>();
  const out: QA[] = [];
  for (const it of items) {
    const k = norm(it.prompt);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ prompt: String(it.prompt || "").trim(), answer: String(it.answer || "").trim() });
  }
  return out;
}
function sanitizeList(arr: unknown, cap = 300): string[] {
  const out: string[] = [];
  if (Array.isArray(arr)) {
    const seen = new Set<string>();
    for (const it of arr) {
      const p = String(it || "").trim();
      if (!p) continue;
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      if (out.length >= cap) break;
    }
  }
  return out;
}

// ---------- Optional RAG helper ----------
// If you have RPC `match_file_chunks(p_user_id uuid, p_file_id uuid, p_query_embedding vector(1536), p_match_count int)`
// we’ll call it; otherwise we silently skip.
async function getRagContext(
  svc: ReturnType<typeof createClient>,
  openai: OpenAI,
  user_id: string,
  file_id: string | null | undefined,
  topic: string,
): Promise<string[]> {
  if (!file_id) return [];
  try {
    // Embed the topic to query relevant chunks
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: topic,
    });
    const vec = emb.data?.[0]?.embedding;
    if (!Array.isArray(vec)) return [];

    const { data, error } = await svc.rpc("match_file_chunks", {
      p_user_id: user_id,
      p_file_id: file_id,
      p_query_embedding: vec,
      p_match_count: 12,
    });

    if (error || !Array.isArray(data)) return [];
    const texts = data
      .map((r: any) => String(r?.content || "").trim())
      .filter(Boolean)
      .slice(0, 12);
    return texts;
  } catch {
    return [];
  }
}

// ---------- LLM call ----------
async function llmGenerate(
  openai: OpenAI,
  topic: string,
  count: number,
  no_repeat: boolean,
  avoid_prompts: string[],
  ragContext: string[],
): Promise<QA[]> {
  const avoidBlock =
    no_repeat && avoid_prompts.length
      ? `Do NOT repeat any of these (or near-duplicates / trivial rephrasings):
${avoid_prompts.map((p) => `- ${p}`).join("\n")}`
      : "";

  const ragBlock =
    ragContext.length
      ? `Use the following reference material when helpful:
${ragContext.map((t, i) => `(${i + 1}) ${t}`).join("\n\n")}`
      : "";

  const system = `You generate concise quiz Q&A as strict JSON. 
Rules:
- Output ONLY JSON (no prose).
- Return an object: {"questions":[{"prompt":"...","answer":"..."}, ...]}
- Each prompt is 1–2 short sentences max. Each answer is a short, exact target string.
- Questions must be distinct from each other.`.trim();

  const user = `
Topic:
${topic}

Requested count: ${count}

${avoidBlock ? "\n" + avoidBlock + "\n" : ""}
${ragBlock ? "\n" + ragBlock + "\n" : ""}

Return exactly:
{"questions":[{"prompt":"...","answer":"..."}, ...]}
(questions length = ${count})
`.trim();

  // Use Chat Completions with JSON bias
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const content = resp.choices?.[0]?.message?.content || "";
  let parsed: any = {};
  try {
    parsed = JSON.parse(content);
  } catch {
    // Fallback: try to salvage JSON if model wrapped it
    const m = content.match(/\{[\s\S]*\}$/);
    parsed = m ? JSON.parse(m[0]) : {};
  }

  const raw = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const out: QA[] = raw
    .map((q: any) => ({
      prompt: String(q?.prompt || "").trim(),
      answer: String(q?.answer || "").trim(),
    }))
    .filter((q: QA) => q.prompt && q.answer);

  return out;
}

// ---------- Handler ----------
Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return text("Method not allowed", 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") || "";

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE);
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // Verify user
    const userRes = await authClient.auth.getUser();
    const user_id = userRes.data.user?.id;
    if (!user_id) return text("Unauthorized", 401);

    // Parse body
    const body = (await req.json()) as ClientReq;
    const title = (body.title || "Generated Quiz").toString().trim();
    const topic = (body.topic || FALLBACK_TOPIC).toString().trim();
    const count = clampCount(body.count);
    const group_id = body.group_id || null;
    const file_id = body.file_id || null;

    const no_repeat = !!body.no_repeat;
    const avoid_prompts = sanitizeList(body.avoid_prompts, 300);

    // Optional RAG context (top-k chunks for this file)
    const ragContext = await getRagContext(svc, openai, user_id, file_id, topic);

    // LLM
    const candidates = await llmGenerate(
      openai,
      topic,
      count,
      no_repeat,
      avoid_prompts,
      ragContext,
    );

    // Enforce no-repeat against provided avoid list (defense-in-depth)
    let final = dedupeByPrompt(candidates);
    if (no_repeat && avoid_prompts.length) {
      const avoidSet = new Set(avoid_prompts.map((p) => p.toLowerCase()));
      final = final.filter((q) => !avoidSet.has(q.prompt.toLowerCase()));
    }

    // If we lost too many to filtering, keep the unique subset anyway
    if (final.length === 0) {
      return json(
        { ok: false, error: "No unique questions produced. Try relaxing no-repeat or changing topic." },
        400,
      );
    }

    // Insert quiz
    const { data, error } = await svc
      .from("quizzes")
      .insert({
        user_id,
        title,
        questions: final,
        group_id,
        file_id,
      })
      .select("id")
      .single();

    if (error) {
      console.error("insert quiz error:", error);
      return text(`Insert error: ${error.message}`, 500);
    }

    return json({ ok: true, quiz_id: data.id, count: final.length });
  } catch (e: any) {
    console.error("generate-quiz error:", e);
    return text(`error: ${e?.message ?? String(e)}`, 400);
  }
});
