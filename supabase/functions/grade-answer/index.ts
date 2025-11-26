// supabase/functions/grade-answer/index.ts
// Heuristic-first grading with LLM fallback that favors semantically correct answers.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import OpenAI from "npm:openai@4.56.0";

let _openai: OpenAI | null = null;
function getOpenAI() {
  if (_openai) return _openai;
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("Missing OPENAI_API_KEY");
  _openai = new OpenAI({ apiKey: key });
  return _openai;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { ...corsHeaders } });

type GradeRequest = {
  question?: string;
  expected?: string;
  user_answer?: string;
};

function normalize(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\b(the|a|an)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lev(a: string, b: string) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function tokenJaccard(a: string, b: string) {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

const CONCEPT_GROUPS = [
  {
    id: "protect",
    keywords: [
      "protect",
      "protection",
      "guard",
      "guardian",
      "defend",
      "defense",
      "safeguard",
      "security",
    ],
  },
  {
    id: "meat-diet",
    keywords: [
      "meat",
      "prey",
      "preys",
      "flesh",
      "carnivore",
      "carnivores",
      "carnivorous",
      "meat eater",
      "meat-eating",
      "other animals",
    ],
  },
];

function conceptTags(str: string) {
  const tags = new Set<string>();
  const tokens = new Set(str.split(" ").filter(Boolean));
  const haystack = ` ${str} `;

  for (const concept of CONCEPT_GROUPS) {
    for (const raw of concept.keywords) {
      const keyword = raw.trim();
      if (!keyword) continue;
      if (keyword.includes(" ")) {
        if (haystack.includes(` ${keyword} `)) {
          tags.add(concept.id);
          break;
        }
      } else if (tokens.has(keyword)) {
        tags.add(concept.id);
        break;
      }
    }
  }

  return tags;
}

function heuristicGrade(expectedRaw: string, userRaw: string) {
  const e = normalize(expectedRaw);
  const u = normalize(userRaw);
  if (!e || !u) return { pass: false, why: "empty" };
  if (e === u) return { pass: true, why: "exact" };

  const d = lev(u, e);
  const maxEdits = Math.max(1, Math.floor(Math.min(u.length, e.length) * 0.2));
  if (d <= maxEdits) return { pass: true, why: `lev<=${maxEdits}` };

  const j = tokenJaccard(u, e);
  if (j >= 0.66) return { pass: true, why: `jaccard-${j.toFixed(2)}` };

  const userConcepts = conceptTags(u);
  const expectedConcepts = conceptTags(e);
  for (const tag of userConcepts) {
    if (expectedConcepts.has(tag)) {
      return { pass: true, why: `concept-${tag}` };
    }
  }

  return { pass: false, why: "heuristic-fail" };
}

async function llmGrade(question: string, expected: string, userAnswer: string) {
  const client = getOpenAI();
  const sys =
    `You grade short quiz answers.\n` +
    `Respond with JSON: {"correct": boolean, "reason": string}.\n` +
    `If the learner's answer expresses the same fact, intent, or concept, mark it correct even if wording differs.\n` +
    `Match question intent. Example: Question "What is the primary diet of lions?" should treat answers "meat", "other animals", or "carnivorous" as correct because they all indicate meat-eating.\n` +
    `Be generous when the answer clearly includes the required idea (e.g., "protect and mate" satisfies a question asking for protection as the main role).\n` +
    `Only mark incorrect when the answer omits the key idea or states a contradictory fact.`;

  const user = JSON.stringify({ question, expected, user_answer: userAnswer });

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: `Grade this:\n${user}` },
    ],
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() ?? "";
  const jsonText = raw.replace(/^```json\s*|\s*```$/g, "");
  try {
    const parsed = JSON.parse(jsonText);
    return {
      correct: Boolean(parsed?.correct),
      reason: typeof parsed?.reason === "string" ? parsed.reason : "LLM evaluation",
    };
  } catch {
    return { correct: false, reason: "LLM parse failure" };
  }
}

import { createClient } from "npm:@supabase/supabase-js@2";

// ... existing imports ...

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") return text("Method not allowed", 405);

  try {
    // --- RATE LIMITING ---
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supa = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });

    const { data: { user } } = await supa.auth.getUser();

    const isAnon = !user ||
      user?.app_metadata?.provider === "anonymous" ||
      user?.user_metadata?.is_anonymous === true ||
      (Array.isArray(user?.identities) &&
        user.identities.some((i: any) => i?.provider === "anonymous"));

    const LIMIT = isAnon ? 5 : 20;
    const WINDOW_MS = 60 * 60 * 1000; // 1 hour

    let rateKey = "";
    if (isAnon) {
      rateKey = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    } else {
      rateKey = user!.id;
    }

    if (rateKey !== "unknown") {
      const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const admin = createClient(supabaseUrl, SERVICE_ROLE);

      const { data: usage } = await admin
        .from("rate_limits")
        .select("*")
        .eq("key", rateKey)
        .eq("endpoint", "grade-answer")
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
        endpoint: "grade-answer",
        count: newCount,
        window_start: newStart
      });
    }

    const { question, expected, user_answer }: GradeRequest = await req.json();

    if (!expected || typeof expected !== "string") {
      return text("Missing expected answer", 400);
    }
    if (!user_answer || typeof user_answer !== "string") {
      return json({ correct: false, reason: "No answer provided" }, 200);
    }

    // Heuristic pass
    const heur = heuristicGrade(expected, user_answer);
    if (heur.pass) {
      return json({ correct: true, reason: heur.why }, 200);
    }

    // LLM fallback
    try {
      const llm = await llmGrade(
        question ?? "",
        expected ?? "",
        user_answer ?? ""
      );
      return json(llm, 200);
    } catch (err) {
      return json({ correct: false, reason: "LLM unavailable" }, 200);
    }
  } catch (e: any) {
    return text(`Server error: ${e?.message ?? e}`, 500);
  }
});
