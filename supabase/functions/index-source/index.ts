// deno.json has "imports": { "openai": "npm:openai" }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import OpenAI from "npm:openai@4.56.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // tighten in prod
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



type ReqBody = {
  text: string;               // raw extracted text from client
  file_id?: string;           // optional; server will create if missing
  file_name?: string;
};

function sentences(str: string) {
  return (str || "").split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

function chunkText(txt: string, targetTokens = 900, overlapTokens = 120) {
  // crude token estimate: ~4 chars/token
  const targetChars = targetTokens * 4;
  const overlapChars = overlapTokens * 4;

  const sents = sentences(txt);
  const chunks: { content: string; page?: number; section?: string }[] = [];

  let cur = "";
  for (const s of sents) {
    if ((cur + " " + s).length > targetChars && cur) {
      chunks.push({ content: cur.trim() });
      // create overlap
      cur = cur.slice(Math.max(0, cur.length - overlapChars));
    }
    cur = (cur ? cur + " " : "") + s;
  }
  if (cur.trim()) chunks.push({ content: cur.trim() });
  return chunks;
}

Deno.serve(async (req) => {
  // ---- CORS helpers (local to this handler) ----
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*", // tighten for prod
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

  // ---- CORS preflight ----
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") return text("Method not allowed", 405);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const openaiKey = Deno.env.get("OPENAI_API_KEY")!;
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") || "";

    // RLS-aware client (user JWT) + service client (for inserts)
    const authClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const svc = createClient(supabaseUrl, serviceKey);

    // Auth
    const userRes = await authClient.auth.getUser();
    const user_id = userRes.data.user?.id;
    if (!user_id) return text("Unauthorized", 401);

    // Body
    const { text: bodyText, file_id: incomingFileId, file_name } =
      (await req.json()) as ReqBody;

    if (!bodyText || bodyText.trim().length < 20) {
      return text("Text too short", 400);
    }

    const file_id = incomingFileId ?? crypto.randomUUID();

    // Chunk + embed
    const chunks = chunkText(bodyText);
    const openai = new OpenAI({ apiKey: openaiKey });
    const embeddings = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunks.map((c) => c.content),
    });

    // Prepare rows
    const rows = chunks.map((c, i) => ({
      user_id,
      file_id,
      file_name: file_name ?? null,
      page: null,
      section: null,
      content: c.content,
      embedding: embeddings.data[i].embedding as unknown as number[],
    }));

    // Insert
    const { error } = await svc.from("file_chunks").insert(rows);
    if (error) {
      console.error("file_chunks insert error:", error);
      return text(`Insert error: ${error.message}`, 500);
    }

    return json({ ok: true, file_id, count: rows.length }, 200);
  } catch (e: any) {
    console.error("index-source error:", e);
    return text(`error: ${e?.message ?? String(e)}`, 400);
  }
});
