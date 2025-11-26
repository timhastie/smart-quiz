import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import OpenAI from "npm:openai@4.56.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY")!;
        const supa = createClient(supabaseUrl, supabaseAnon, {
            global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
        });

        // Auth check
        const { data: { user }, error: authError } = await supa.auth.getUser();
        if (authError || !user) {
            return new Response("Unauthorized", { status: 401, headers: corsHeaders });
        }

        // Get audio file from form data
        const formData = await req.formData();
        const audioFile = formData.get("file");

        if (!audioFile || !(audioFile instanceof File)) {
            return new Response("No audio file provided", { status: 400, headers: corsHeaders });
        }

        const apiKey = Deno.env.get("OPENAI_API_KEY");
        if (!apiKey) {
            return new Response("Missing OpenAI API Key", { status: 500, headers: corsHeaders });
        }

        const openai = new OpenAI({ apiKey });

        // Transcribe
        const transcription = await openai.audio.transcriptions.create({
            file: audioFile,
            model: "whisper-1",
            language: "en", // Optional: force English or detect automatically
        });

        return new Response(JSON.stringify({ text: transcription.text }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }
});
