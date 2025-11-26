import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import OpenAI from "npm:openai@4.56.0";

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
