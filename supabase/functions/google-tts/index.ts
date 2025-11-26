import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    try {
        // 1. Verify Auth
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) {
            throw new Error("Missing Authorization header");
        }

        // 2. Get Google API Key
        const apiKey = Deno.env.get("GOOGLE_CLOUD_API_KEY");
        if (!apiKey) {
            console.error("Missing GOOGLE_CLOUD_API_KEY");
            return new Response(
                JSON.stringify({ error: "Server configuration error: Missing API Key" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const url = new URL(req.url);
        const path = url.pathname.split("/").pop(); // "voices" or "synthesize"

        // --- GET /voices ---
        if (path === "voices") {
            const resp = await fetch(
                `https://texttospeech.googleapis.com/v1/voices?key=${apiKey}`
            );
            if (!resp.ok) {
                const err = await resp.text();
                throw new Error(`Google API error: ${err}`);
            }
            const data = await resp.json();

            // Filter for high quality voices if desired, or return all
            // Let's return all but maybe sort/prioritize on frontend
            return new Response(JSON.stringify(data), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // --- POST /synthesize ---
        if (path === "synthesize") {
            const { text, voiceParams } = await req.json();

            if (!text) throw new Error("Missing 'text'");

            // Default to a nice voice if none provided
            const voice = voiceParams || {
                languageCode: "en-US",
                name: "en-US-Neural2-J", // A good default
                ssmlGender: "MALE"
            };

            const payload = {
                input: { text },
                voice: voice,
                audioConfig: {
                    audioEncoding: "MP3",
                    effectsProfileId: ["headphone-class-device"], // Optimize for headphones
                },
            };

            const resp = await fetch(
                `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
                {
                    method: "POST",
                    body: JSON.stringify(payload),
                }
            );

            if (!resp.ok) {
                const err = await resp.text();
                throw new Error(`Google API error: ${err}`);
            }

            const data = await resp.json();
            // data.audioContent is base64 encoded string

            return new Response(JSON.stringify(data), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        return new Response("Not Found", { status: 404, headers: corsHeaders });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
