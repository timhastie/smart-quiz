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
                .eq("endpoint", "generate-hint")
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
                endpoint: "generate-hint",
                count: newCount,
                window_start: newStart
            });
        }

        const { question, answer } = await req.json();

        if (!question || !answer) {
            return new Response(JSON.stringify({ error: "Question and answer are required" }), {
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

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `You are a helpful assistant providing hints for quiz questions. 
                    The user will provide a question and an answer. 
                    Your goal is to provide a short, helpful hint that nudges the user towards the answer without giving it away explicitly. 
                    Be concise. Do not use the answer word in the hint if possible.`
                },
                {
                    role: "user",
                    content: `Question: ${question}\nAnswer: ${answer}`
                }
            ],
            temperature: 0.7,
            max_tokens: 100,
        });

        const hint = completion.choices[0].message.content || "No hint available.";

        return new Response(JSON.stringify({ hint }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }
});
