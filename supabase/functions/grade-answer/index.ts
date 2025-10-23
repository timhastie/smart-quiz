// supabase/functions/grade-answer/index.ts
import OpenAI from "npm:openai";
import { createClient } from "npm:@supabase/supabase-js";

const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY")! });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { ...corsHeaders } });

/* ================== Tunables ================== */
const USE_EMBEDDINGS = false;           // keep false for speed
const JUDGE_TIMEOUT_MS = 2500;          // LLM judge max time

/* ================== Helpers ================== */
const STOP = new Set([
  "the","a","an","to","of","in","on","at","for","with","and","or","is","are","be",
  "this","that","these","those","as","by","from","into","over","under","up","down","all"
]);

const DESCRIPTORS = new Set([
  "dynamic","performance","live","studio","digital","analog","hybrid","virtual","hardware",
  "software","multi","mono","poly","polyphonic","stereo","portable","modular","advanced",
  "basic","external","internal","integrated","classic","modern","compact"
]);

const norm = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

const toks = (s: string) => norm(s).split(" ").filter(w => w && !STOP.has(w));

const numTokens = (s: string) => (s.match(/-?\d+(\.\d+)?/g) || []).map(x => x.trim());
const yearTokens = (s: string) => (s.match(/\b(1[6-9]\d{2}|20\d{2})\b/g) || []).map(Number); // 1600–2099

/** remove generic adjectives; keep meaningful nouns */
function stripDescriptors(s: string) {
  return toks(s).filter(w => !DESCRIPTORS.has(w)).join(" ");
}
/** last noun-ish token */
function headNounish(s: string) {
  const arr = stripDescriptors(s).split(" ").filter(Boolean);
  return arr.length ? arr[arr.length - 1] : "";
}
/** allow “sampler” ≈ “dynamic performance sampler” etc. */
function generousTypeMatch(userAns: string, expected: string) {
  const u = stripDescriptors(userAns);
  const e = stripDescriptors(expected);
  if (!u || !e) return false;
  if (u === e) return true;
  if (u.length >= 3 && (e.includes(u) || u.includes(e))) return true;
  const hu = headNounish(userAns);
  const he = headNounish(expected);
  if (hu && he && hu === he) return true;
  const uT = new Set(u.split(" ").filter(w => w.length >= 3));
  const eT = new Set(e.split(" ").filter(w => w.length >= 3));
  if (uT.size === 1 && eT.has([...uT][0])) return true;
  return false;
}

function hexDecEqual(a: string, b: string) {
  const hexRe = /^(?:\$|0x)?[0-9a-f]+$/i;
  const toNum = (s: string) => {
    const t = s.trim();
    if (hexRe.test(t)) return parseInt(t.replace(/^\$|0x/i, ""), 16);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    return NaN;
  };
  const va = toNum(a), vb = toNum(b);
  return Number.isFinite(va) && va === vb;
}

/** classify: should this be STRICT fact? */
function isStrictFact(question: string, expected: string) {
  const q = norm(question);
  const hasYear = yearTokens(expected).length > 0;
  const hasAnyNumber = numTokens(expected).length > 0;

  // Prompts that imply numeric/date exactness
  const qHints = /(when|what year|which year|date|how many|how much|what number|tempo|bpm|cc|control change|port|channel|track|bank|pattern|page|step)\b/;

  // Very short canonical answers (<= 3 tokens) that are numeric or code-like => strict
  const shortCanon = toks(expected).length <= 3;
  const codeLike = /0x|\$|\bcc\b|\bctl\b|\bbpm\b|\bhz\b|\bkhz\b|\bdb\b|\bms\b|\bs\b|\d/.test(expected.toLowerCase());

  return hasYear || (hasAnyNumber && (qHints.test(q) || shortCanon || codeLike));
}

/** strict compare for facts:
 * - if expected has one year -> require exact same year
 * - if expected has numbers -> require same set (order-free)
 * - if expected looks code-ish -> require exact (or hex/dec equiv)
 */
function strictFactCorrect(userAns: string, expected: string) {
  // exact or hex/decimal equivalence
  if (norm(userAns) === norm(expected) || hexDecEqual(userAns, expected)) return true;

  const expYears = yearTokens(expected);
  const usrYears = yearTokens(userAns);
  if (expYears.length === 1) return usrYears.length === 1 && usrYears[0] === expYears[0];

  const expNums = numTokens(expected);
  if (expNums.length > 0) {
    const usrNums = numTokens(userAns);
    if (usrNums.length !== expNums.length) return false;
    const a = [...expNums].sort().join(",");
    const b = [...usrNums].sort().join(",");
    return a === b;
  }
  return false;
}

/* Optional embeddings (disabled) */
async function cosineSim(a: string, b: string) {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: [a.slice(0, 2000), b.slice(0, 2000)],
  });
  const v1 = res.data[0].embedding as number[];
  const v2 = res.data[1].embedding as number[];
  const dot = (x:number[],y:number[]) => x.reduce((s,xi,i)=>s+xi*y[i],0);
  const mag = (x:number[]) => Math.sqrt(x.reduce((s,xi)=>s+xi*xi,0));
  return dot(v1,v2)/(mag(v1)*mag(v2));
}

/* Single, short LLM judge */
async function judgeWithTimeout(question: string, expected: string, userAns: string) {
  const sys = `You are a fair grader. Rules:
- If the question asks for a *fact* (year, count, date, number, code), require exact correctness.
- If the reference has a year or clear number, the student must supply the same number.
- Otherwise, accept reasonable paraphrases or super/subclass matches (e.g., "sampler" ≈ "dynamic performance sampler").
Return ONLY JSON: {"correct": boolean, "reasons": string}.`;
  const user = `Q: ${question || "(no question provided)"}\nREFERENCE: ${expected}\nSTUDENT: ${userAns}`;
  const p = openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    response_format: { type: "json_object" as const },
  });
  const timeout = new Promise<{correct:boolean;reasons:string}>(resolve =>
    setTimeout(() => resolve({ correct: false, reasons: "judge timeout" }), JUDGE_TIMEOUT_MS)
  );
  const resp = await Promise.race([p, timeout]) as any;
  if (resp?.choices) {
    const raw = resp.choices[0].message?.content?.trim() ?? `{"correct":false,"reasons":"no output"}`;
    try { return JSON.parse(raw); } catch {}
  }
  return resp;
}

/* ================== Handler ================== */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  try {
    if (req.method !== "POST") return text("Method not allowed", 405);

    // Auth (RLS-safe)
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supa = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: userRes } = await supa.auth.getUser();
    if (!userRes?.user) return text("Unauthorized", 401);

    // Body (support old/new keys)
    const body = await req.json().catch(() => ({} as any));
    const question: string = String(body?.question ?? body?.prompt ?? "");
    const expected: string = String(body?.expected ?? body?.answer ?? "");
    const user_answer: string = String(body?.user_answer ?? body?.user ?? "");

    const dbg = {
      question,
      expected,
      user_answer,
      expYears: (expected.match(/\b(1[6-9]\d{2}|20\d{2})\b/g) || []),
      usrYears: (user_answer.match(/\b(1[6-9]\d{2}|20\d{2})\b/g) || []),
      expNums: (expected.match(/-?\d+(\.\d+)?/g) || []),
      usrNums: (user_answer.match(/-?\d+(\.\d+)?/g) || []),
      isStrict: isStrictFact(question, expected),
    };

    if (!user_answer) return json({ correct: false, score: 0, feedback: "No answer provided.", debug: dbg }, 200);
    if (!expected && !question) return json({ correct: false, score: 0, feedback: "Reference missing.", debug: dbg }, 200);

    // Fast exact / numeric equivalence
    if (norm(user_answer) === norm(expected) || hexDecEqual(user_answer, expected)) {
      return json({ correct: true, score: 1, reasons: "exact/equivalent", feedback: "Correct!", debug: dbg }, 200);
    }

    // STRICT FACTS: years / numbers / counts / codes
    if (dbg.isStrict) {
      const ok = strictFactCorrect(user_answer, expected);
      return json({
        correct: ok,
        score: ok ? 1 : 0,
        reasons: ok ? "strict fact match" : "strict fact mismatch",
        feedback: ok ? "Correct!" : "Incorrect — this requires the exact value.",
        debug: dbg,
      }, 200);
    }

    // NON-FACT: type/definition/description → be generous
    if (generousTypeMatch(user_answer, expected)) {
      return json({ correct: true, score: 1, reasons: "head-noun/substring", feedback: "Correct!", debug: dbg }, 200);
    }

    if (USE_EMBEDDINGS) {
      try {
        const sim = await cosineSim(user_answer, expected);
        if (sim >= 0.78) {
          return json({ correct: true, score: 1, reasons: `sim=${sim.toFixed(2)}`, feedback: "Correct!", debug: dbg }, 200);
        }
      } catch { /* ignore */ }
    }

    // One short judge call (still obeys strict facts rule in its prompt)
    const judge = await judgeWithTimeout(question, expected, user_answer);
    const correct = !!judge?.correct;
    return json({
      correct,
      score: correct ? 1 : 0,
      reasons: judge?.reasons || "n/a",
      feedback: correct ? "Correct!" : "Incorrect.",
      debug: dbg,
    }, 200);
  } catch (e: any) {
    console.error("grade-answer error:", e);
    return text(`Server error: ${e?.message ?? String(e)}`, 500);
  }
});
