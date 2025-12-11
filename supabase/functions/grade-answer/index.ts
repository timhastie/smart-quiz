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
  mode?: "creative" | "standard";
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

function extractNumbers(s: string) {
  // Extract integers or decimals. normalize() already removed some punctuation but kept alphanumeric.
  // We'll look for simple digit sequences.
  return s.match(/\d+/g) || [];
}

function heuristicGrade(expectedRaw: string, userRaw: string) {
  const e = normalize(expectedRaw);
  const u = normalize(userRaw);
  if (!e || !u) return { pass: false, why: "empty" };

  // --- STRICT NUMBER CHECK ---
  // If the expected answer contains digits, the user's answer MUST contain those same digits.
  // This prevents atomic typos like "1995" vs "1999" from passing via Levenshtein.
  const eNums = extractNumbers(e);
  if (eNums.length > 0) {
    const uNums = new Set(extractNumbers(u));
    // Every number in expected must appear in user answer
    for (const num of eNums) {
      if (!uNums.has(num)) {
        return { pass: false, why: "number-mismatch" };
      }
    }
  }

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

async function llmGrade(question: string, expected: string, userAnswer: string, mode: "creative" | "standard" = "standard") {
  const client = getOpenAI();

  let sys = "";
  if (mode === "creative") {
    sys =
      `You grade creative or open-ended quiz answers.\n` +
      `Respond with JSON: {"correct": boolean, "reason": string}.\n` +
      `The 'expected' answer is just an example. Do NOT require the user to match it word-for-word.\n` +
      `Evaluate if the user's answer is a valid, logical, and correct response to the question.\n` +
      `IMPORTANT EXCEPTION for NUMBERS/DATES/FACTS: If the question asks for a specific year, date, count, or factual number (e.g., "What year?", "How many?"), the user's answer MUST contain the exact correct number. If the correct answer is "1999" and the user writes "1995", it is INCORRECT.\n` +
      `Example: "Use 'ubiquitous' in a sentence" -> ANY valid sentence is CORRECT.\n` +
      `Example: "What year did Tony Hawk land the 900?" -> "1999" is CORRECT. "1995" is INCORRECT.\n` +
      `Mark INCORRECT if the answer is factually wrong, irrelevant, or fails to address the prompt.`;
  } else {
    sys =
      `You grade short quiz answers.\n` +
      `Respond with JSON: {"correct": boolean, "reason": string}.\n` +
      `If the learner's answer expresses the same fact, intent, or concept, mark it correct even if wording differs.\n` +
      `STRICT NUMERIC CHECK: If the answer requires a specific number (year, quantity, date), the user MUST provide that exact number. Close numbers (e.g. 1995 vs 1999) are INCORRECT.\n` +
      `Match question intent. Example: "What is the primary diet of lions?" -> "meat", "other animals", "carnivorous" are all CORRECT.\n` +
      `Be generous with wording, but strict with facts and numbers.\n` +
      `Only mark incorrect when the answer omits the key idea, gets the core fact/number wrong, or states a contradictory fact.`;
  }

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

    const { question, expected, user_answer, mode }: GradeRequest = await req.json();

    if (!user_answer || typeof user_answer !== "string") {
      return json({ correct: false, reason: "No answer provided" }, 200);
    }

    // In standard mode, we require an expected answer. In creative mode, it's optional context.
    if ((!mode || mode === "standard") && (!expected || typeof expected !== "string")) {
      return text("Missing expected answer", 400);
    }

    const safeExpected = expected || "";
    const safeQuestion = question || "";
    const isCreative = mode === "creative";

    // Heuristic pass (ONLY for standard mode)
    if (!isCreative) {
      const heur = heuristicGrade(safeExpected, user_answer);
      if (heur.pass) {
        return json({ correct: true, reason: heur.why }, 200);
      }
    }

    // LLM fallback (or primary for creative)
    try {
      const result = await llmGrade(safeQuestion, safeExpected, user_answer, isCreative ? "creative" : "standard");
      return json(result, 200);
    } catch (e) {
      return text("LLM error", 500);
    }
  } catch (e: any) {
    return text(`Server error: ${e?.message ?? e}`, 500);
  }
});
