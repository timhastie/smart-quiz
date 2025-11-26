import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import OpenAI from "npm:openai@4.56.0";

import { createClient } from "npm:@supabase/supabase-js@2";

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

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

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
                .eq("endpoint", "suggest-prompts")
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
                endpoint: "suggest-prompts",
                count: newCount,
                window_start: newStart
            });
        }

        const { topic, context } = await req.json();

        if (!topic && !context) {
            return new Response(JSON.stringify({ error: "Topic or context is required" }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders },
            });
        }

        const apiKey = Deno.env.get("OPENAI_API_KEY");
        if (!apiKey) {
            return new Response(JSON.stringify({ error: "Missing API key" }), {
                status: 500,
                headers: { "Content-Type": "application/json", ...corsHeaders },
            });
        }

        const openai = new OpenAI({ apiKey });

        let systemContent = `You are a creative assistant helping a user generate quiz prompts.
          Based on the user's input topic (which might be a simple word like "Lions" or "Bash"), generate 4 distinct, engaging, and specific quiz prompt ideas.
          Return ONLY a JSON array of strings. Do not include any other text or markdown formatting.
          Example output: ["Make a quiz about lion social structures", "Create a quiz testing knowledge of lion hunting tactics", "Generate a quiz about the history of lions in culture", "Make a fun fact quiz about lions"]`;

        let userContent = `Topic: ${topic}`;

        if (context) {
            const truncatedContext = context.slice(0, 15000);
            systemContent = `You are a creative assistant helping a user generate quiz prompts based on a provided transcript or document.
          Analyze the provided context and generate 4 distinct, engaging, and specific quiz prompt ideas that cover different aspects of the content.
          Return ONLY a JSON array of strings. Do not include any other text or markdown formatting.`;
            userContent = `Topic: ${topic || "General"}\n\nContext:\n${truncatedContext}`;
        }

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: systemContent
                },
                {
                    role: "user",
                    content: userContent
                }
            ],
            temperature: 0.7,
        });

        const raw = completion.choices[0].message.content || "[]";
        let suggestions = [];
        try {
            // Clean up potential markdown code blocks if the model ignores instructions
            const cleanJson = raw.replace(/^```json\s*|\s*```$/g, "");
            suggestions = JSON.parse(cleanJson);
        } catch (e) {
            console.error("Failed to parse OpenAI response", raw);
            suggestions = [];
        }

        return new Response(JSON.stringify({ suggestions }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }
});
