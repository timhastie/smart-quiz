// supabase/functions/index-source/index.ts
// Deno Edge Function — indexes raw text into file_chunks with embeddings.
// Expects JSON: { text: string, file_name?: string }
// Returns: { file_id: string, file_name: string, chunks: number }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import OpenAI from "npm:openai@4.56.0";
import { createClient } from "npm:@supabase/supabase-js@2";


// ---------- CORS ----------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { ...corsHeaders } });

// ---------- Chunking ----------
function chunkText(s: string, size = 1800, overlap = 200): string[] {
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const end = Math.min(i + size, n);
    out.push(s.slice(i, end));
    if (end >= n) break;
    i = end - overlap;
    if (i < 0) i = 0;
  }
  // trim junk lines
  return out.map((c) => c.replace(/\s+\n/g, "\n").trim()).filter(Boolean);
}

// ---------- Handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return text("Method not allowed", 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") || "";

    const auth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE);
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // Auth -> user_id (RLS-friendly)
    const { data: u } = await auth.auth.getUser();
    const user_id = u.user?.id;
    if (!user_id) return text("Unauthorized", 401);

    // Body
    const body = await req.json().catch(() => ({} as any));
    let textIn: string = String(body?.text ?? "");
    let file_name: string = String(body?.file_name ?? "").trim() || "document.txt";
    const youtube_url = body?.youtube_url ? String(body.youtube_url).trim() : undefined;
    const fetch_only = body?.fetch_only;
    const action = body?.action; // 'list_transcripts' or undefined
    const language_code = body?.language_code;
    const is_generated = body?.is_generated;
    const fetch_options = body?.fetch_options;

    if (youtube_url) {
      const SUPADATA_API_KEY = "sd_6bee9cf2be2962a94a7256c1d0042824";

      try {
        // If action is 'list_transcripts' OR fetch_options is true, fetch metadata
        if (action === 'list_transcripts' || fetch_options) {
          // We fetch the default transcript to get the list of available languages
          const supRes = await fetch(`https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(youtube_url)}&text=true`, {
            headers: { "x-api-key": SUPADATA_API_KEY }
          });

          if (!supRes.ok) {
            const errText = await supRes.text();
            return text(`Supadata Error: ${errText}`, 400);
          }

          const supData = await supRes.json();
          let availableLangs = supData.availableLangs || [];

          // Fallback: if availableLangs is empty but 'lang' is present, use that
          if (availableLangs.length === 0 && supData.lang) {
            availableLangs = [supData.lang];
          }

          // Map to the format expected by the frontend
          const transcripts = availableLangs.map((lang: string) => ({
            language: lang, // Supadata only gives code, so use it for name too
            language_code: lang,
            is_generated: false, // We don't know, assume false or irrelevant
            is_translatable: true
          }));

          if (transcripts.length === 0) {
            // Return raw response for debugging if no transcripts found
            return text(`No transcripts found. Supadata Response: ${JSON.stringify(supData)}`, 400);
          }

          return json({ transcripts }, 200);
        }

        // Otherwise, fetch transcript
        let fetchUrl = `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(youtube_url)}&text=true`;
        if (language_code) {
          fetchUrl += `&lang=${language_code}`;
        }

        const supRes = await fetch(fetchUrl, {
          headers: { "x-api-key": SUPADATA_API_KEY }
        });

        if (!supRes.ok) {
          const errText = await supRes.text();
          return text(`Supadata Error: ${errText}`, 400);
        }

        const supData = await supRes.json();
        textIn = supData.content;
        file_name = youtube_url;

      } catch (e: any) {
        return text(`Failed to call Supadata: ${e.message}`, 500);
      }
    }

    if (!textIn) return text("No text provided", 400);

    // If fetch_only is requested, return the text immediately without indexing
    if (fetch_only) {
      return json({ transcript: textIn }, 200);
    }

    // Cap extremely large inputs (~500k chars)
    if (textIn.length > 500_000) textIn = textIn.slice(0, 500_000);

    // Chunk
    const chunks = chunkText(textIn);
    if (chunks.length === 0) return text("No indexable content", 400);

    // Embeddings (batch)
    const inputs = chunks.map((c) => c.slice(0, 8000)); // guard length
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: inputs,
    });
    const vectors: number[][] = emb.data.map((d: any) => d.embedding as number[]);

    // New file_id
    const file_id = crypto.randomUUID();

    // Prepare rows
    const rows = chunks.map((content, i) => ({
      user_id,
      file_id,
      file_name,         // <-- store human-readable name
      chunk_index: i,
      content,
      embedding: vectors[i],
    }));

    // Insert
    const { error } = await svc.from("file_chunks").insert(rows);
    if (error) {
      return text(`Insert error: ${error.message}`, 500);
    }

    return json({ file_id, file_name, chunks: rows.length }, 200);
  } catch (e: any) {
    return text(`error: ${e?.message ?? String(e)}`, 500);
  }
});
