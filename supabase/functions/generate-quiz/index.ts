// CORS-enabled generate-quiz with automatic novelty (no exact/near dupes within a group)
// + RAG retrieval from file_chunks via RPC `match_file_chunks`
import OpenAI from "npm:openai";
import { createClient } from "npm:@supabase/supabase-js";

const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY")! });

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

/** Lowercase, collapse spaces, strip punctuation */
function normalize(s: string) {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

/** Very small stopword list to make similarity less fragile */
const STOP = new Set([
  "the","a","an","to","of","in","on","at","for","with","and","or","is","are","be","this","that","these","those","as","by","from","into","over","under","up","down","all"
]);

function tokenize(s: string) {
  return normalize(s)
    .split(" ")
    .filter((w) => w && !STOP.has(w));
}

/** Jaccard similarity of token sets */
function jaccard(a: string, b: string) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/** Treat as near-duplicate if token Jaccard is very high */
function isNearDuplicate(a: string, b: string, threshold = 0.9) {
  return jaccard(a, b) >= threshold;
}

/** --- RAG: fetch top-k chunks via RPC (safe fallback to empty on error) --- */
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
  // Create a short “query intent” string to embed
  const queryText = `Generate ${n} quiz questions about: ${topic || title || "the uploaded document"}`;

  // 1) Embed the query
  const emb = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: queryText,
  });
  const vec = emb.data[0].embedding as unknown as number[];

  // 2) Call RPC to match chunks (you must create this in your DB; see SQL below)
  // Signature example:
  // create or replace function match_file_chunks(
  //   p_user_id uuid,
  //   p_file_id text,
  //   p_query_embedding vector(1536),
  //   p_match_count int default 15
  // ) returns table(content text, similarity float) language sql as $$
  //   select content,
  //          1 - (embedding <=> p_query_embedding) as similarity
  //   from file_chunks
  //   where user_id = p_user_id and file_id = p_file_id
  //   order by embedding <-> p_query_embedding
  //   limit p_match_count;
  // $$;
  try {
    const { data, error } = await supa.rpc("match_file_chunks", {
      p_user_id: userId,
      p_file_id: fileId,
      p_query_embedding: vec,
      p_match_count: k,
    });
    if (error || !data?.length) return [];
    // data: [{ content: string, similarity: number }, ...]
    return data.map((r: any) => String(r.content || "")).filter(Boolean);
  } catch {
    return [];
  }
}

async function llmGenerate(
  n: number,
  prompt: string,
  priorPromptsForContext: string[],
  docContext: string // NEW: concatenated top chunks (may be "")
): Promise<QA[]> {
  const sys = `You generate quiz questions.
Return ONLY a JSON array of objects with keys "prompt" and "answer".
No markdown, no code fences, no commentary.`;

  // Bound context to keep tokens manageable
  const priorSlice = priorPromptsForContext.slice(0, 200);
  const priorText =
    priorSlice.length > 0
      ? `Here are prior prompts for context (avoid repeating them verbatim; prefer new angles and extended coverage):\n${JSON.stringify(
          priorSlice,
          null,
          0
        )}`
      : "";

  const docText = docContext
    ? `\nUse ONLY the following document excerpts as your source material. Ground your questions in this content.\n---DOC CONTEXT START---\n${docContext}\n---DOC CONTEXT END---\n`
    : "";

  const userMsg =
    `Create ${n} question/answer pairs about: ${prompt}\n` +
    `Make questions varied and pedagogically useful (from fundamentals to extensions).\n` +
    `Answers must be exact strings a learner can type (no prose).\n` +
    `Example element: { "prompt": "Print dog", "answer": "console.log('dog')" }\n\n` +
    priorText +
    docText;

  const resp = await openai.chat.completions.create({
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

    // Supabase client (forward caller's JWT so RLS applies)
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supa = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });

    // Auth
    const { data: userRes, error: userErr } = await supa.auth.getUser();
    if (userErr || !userRes?.user) return text("Unauthorized", 401);
    const user = userRes.user;

    // Body (NOW accepts file_id)
    const { title, topic, count, group_id, file_id } = await req.json();
    const n = Math.max(1, Math.min(Number(count) || 10, 30));
    const safeTitle = String(title || "Generated Quiz").slice(0, 120);
    const prompt = String(topic || "Create programming quiz questions.").slice(0, 2000);

    // If a group is specified, load all prior prompts in that group
    let targetGroupId: string | null = null;
    let priorPrompts: string[] = [];

    if (group_id) {
      // Verify the group belongs to the user
      const { data: g, error: gErr } = await supa
        .from("groups")
        .select("id")
        .eq("id", group_id)
        .eq("user_id", user.id)
        .maybeSingle();

      if (!gErr && g?.id) {
        targetGroupId = g.id;

        // Get prior prompts from quizzes in this group
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
    }

    // --- RAG: retrieve top-k relevant chunks if file_id is provided ---
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
        // Keep doc context bounded (both in count and characters)
        const joined = chunks.join("\n\n");
        docContext = joined.length > 12000 ? joined.slice(0, 12000) : joined;
      } catch {
        // If retrieval fails, proceed without context
        docContext = "";
      }
    }

    // Round 1 (now with docContext)
    let generated = await llmGenerate(n, prompt, priorPrompts, docContext);

    // Server-side novelty enforcement:
    // 1) Drop exact duplicates vs prior
    const priorSeen = new Set(priorPrompts.map(normalize));
    let unique = generated.filter((qa) => !priorSeen.has(normalize(qa.prompt)));

    // 2) Drop near-duplicates vs prior (very similar phrasing)
    if (priorPrompts.length > 0) {
      unique = unique.filter((qa) => {
        for (const p of priorPrompts) {
          if (isNearDuplicate(qa.prompt, p, 0.9)) return false;
        }
        return true;
      });
    }

    // If we dropped some, try one refill for the remainder
    if (unique.length < n) {
      const need = n - unique.length;

      // Expand the "avoid" memory with accepted prompts so far
      const expandedAvoid = [...priorPrompts, ...unique.map((x) => x.prompt)];

      const refill = await llmGenerate(
        need,
        prompt + " (add new or extended questions that are not already covered above)",
        expandedAvoid,
        docContext
      );

      // Filter refill against BOTH: prior AND newly accepted
      const combinedSeen = new Set(expandedAvoid.map(normalize));
      const refillFiltered = refill.filter((qa) => {
        const norm = normalize(qa.prompt);
        if (combinedSeen.has(norm)) return false;
        for (const p of expandedAvoid) {
          if (isNearDuplicate(qa.prompt, p, 0.9)) return false;
        }
        return true;
      });

      generated = [...unique, ...refillFiltered].slice(0, n);
    } else {
      generated = unique.slice(0, n);
    }

    if (generated.length === 0) return text("No usable questions.", 400);

    // Insert quiz (include group_id if present)
    const { data, error } = await supa
  .from("quizzes")
  .insert({
    user_id: user.id,
    title: safeTitle,
    questions: generated,
    group_id: targetGroupId,
    file_id: file_id || null, // <-- store the indexed source id
  })
  .select("id, group_id, file_id")
  .single();

    if (error) {
      console.error("DB insert failed:", error);
      return text(`Failed to insert quiz: ${error.message}`, 500);
    }

    return json({ id: data.id, group_id: data.group_id }, 200);
  } catch (e: any) {
    console.error("Unhandled:", e);
    return text(`Server error: ${e?.message ?? e}`, 500);
  }
});
