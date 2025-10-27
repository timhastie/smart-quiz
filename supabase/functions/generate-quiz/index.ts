// CORS-enabled generate-quiz with novelty controls, optional in-place regeneration,
// RAG retrieval from file_chunks via RPC `match_file_chunks`
import OpenAI from "npm:openai";
import { createClient } from "npm:@supabase/supabase-js";

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

function normalize(s: string) {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

const STOP = new Set([
  "the","a","an","to","of","in","on","at","for","with","and","or","is","are","be","this","that","these","those","as","by","from","into","over","under","up","down","all",
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

function isNearDuplicate(a: string, b: string, threshold = 0.9) {
  return jaccard(a, b) >= threshold;
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

async function llmGenerate(
  n: number,
  prompt: string,
  priorPromptsForContext: string[],
  docContext: string
): Promise<QA[]> {
  const sys = `You generate quiz questions.
Return ONLY a JSON array of objects with keys "prompt" and "answer".
No markdown, no code fences, no commentary.`;

  const priorSlice = priorPromptsForContext.slice(0, 200);
  const priorText =
    priorSlice.length > 0
      ? `Here are prior prompts for context (avoid repeating them verbatim; prefer new angles and extended coverage):\n${JSON.stringify(
          priorSlice
        )}`
      : "";

  const docText = docContext
    ? `\nUse ONLY the following document excerpts as your source material.\n---DOC CONTEXT START---\n${docContext}\n---DOC CONTEXT END---\n`
    : "";

  const userMsg =
    `Create ${n} question/answer pairs about: ${prompt}\n` +
    `Make questions varied and pedagogically useful (from fundamentals to extensions).\n` +
    `Answers must be exact strings a learner can type (no prose).\n` +
    `Example element: { "prompt": "Print dog", "answer": "console.log('dog')" }\n\n` +
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
      replace_quiz_id, // NEW: update existing quiz instead of inserting
      no_repeat,        // NEW: optional toggle from client (default true)
      avoid_prompts,    // NEW: optional extra prior prompts from client
    } = await req.json();

    const n = Math.max(1, Math.min(Number(count) || 10, 30));
    const safeTitle = String(title || "Generated Quiz").slice(0, 120);
    const prompt = String(topic || "Create programming quiz questions.").slice(0, 2000);
    const wantNoRepeat = no_repeat !== false; // default = true

    // Fast trial-cap precheck only if we are INSERTING a new quiz
    if (!replace_quiz_id) {
      const isAnon =
        user?.app_metadata?.provider === "anonymous" ||
        user?.user_metadata?.is_anonymous === true ||
        (Array.isArray(user?.identities) &&
          user.identities.some((i: any) => i?.provider === "anonymous"));

      if (isAnon) {
        const { count: quizCount, error: cErr } = await supa
          .from("quizzes")
          .select("id", { count: "exact", head: true });
        if (!cErr && (quizCount ?? 0) >= 2) {
          return text(
            "Free trial limit reached. Create an account to make more quizzes.",
            403
          );
        }
      }
    }

    // Validate/resolve target group
    let targetGroupId: string | null = null;
    if (group_id) {
      const { data: g, error: gErr } = await supa
        .from("groups")
        .select("id")
        .eq("id", group_id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!gErr && g?.id) targetGroupId = g.id;
    }

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

    // Generate
    let generated = await llmGenerate(n, prompt, priorPrompts, docContext);

    if (wantNoRepeat && priorPrompts.length > 0) {
      // exact
      const priorSeen = new Set(priorPrompts.map(normalize));
      let unique = generated.filter((qa) => !priorSeen.has(normalize(qa.prompt)));
      // near
      unique = unique.filter((qa) => {
        for (const p of priorPrompts) {
          if (isNearDuplicate(qa.prompt, p, 0.9)) return false;
        }
        return true;
      });

      // Refill once if short
      if (unique.length < n) {
        const need = n - unique.length;
        const expandedAvoid = [...priorPrompts, ...unique.map((x) => x.prompt)];
        const refill = await llmGenerate(
          need,
          prompt + " (add new or extended questions that are not already covered above)",
          expandedAvoid,
          docContext
        );
        const combinedSeen = new Set(expandedAvoid.map(normalize));
        const refillFiltered = refill.filter((qa) => {
          const norm = normalize(qa.prompt);
          if (combinedSeen.has(norm)) return false;
          for (const p of expandedAvoid) if (isNearDuplicate(qa.prompt, p, 0.9)) return false;
          return true;
        });
        generated = [...unique, ...refillFiltered].slice(0, n);
      } else {
        generated = unique.slice(0, n);
      }
    } else {
      generated = generated.slice(0, n);
    }

    if (generated.length === 0) return text("No usable questions.", 400);

    const now = new Date().toISOString();

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
          questions: generated,
          group_id: targetGroupId,
          file_id: file_id || null,
          source_prompt: prompt,        // <-- save prompt
          updated_at: now,
        })
        .eq("id", replace_quiz_id)
        .eq("user_id", user.id);

      if (upErr) {
        console.error("DB update failed:", upErr);
        return text(`Failed to update quiz: ${upErr.message}`, 500);
      }
      return json({ id: replace_quiz_id, group_id: targetGroupId }, 200);
    }

    // INSERT (new quiz)
    const { data, error } = await supa
      .from("quizzes")
      .insert({
        user_id: user.id,
        title: safeTitle,
        questions: generated,
        group_id: targetGroupId,
        file_id: file_id || null,
        source_prompt: prompt,          // <-- save prompt
        created_at: now,
        updated_at: now,
      })
      .select("id, group_id, file_id")
      .single();

    if (error) {
      if ((error as any).code === "42501") {
        return text("Free trial limit reached. Create an account to make more quizzes.", 403);
      }
      console.error("DB insert failed:", error);
      return text(`Failed to insert quiz: ${error.message}`, 500);
    }

    return json({ id: data.id, group_id: data.group_id }, 200);
  } catch (e: any) {
    console.error("Unhandled:", e);
    return text(`Server error: ${e?.message ?? e}`, 500);
  }
});
