// supabase/functions/record-shared-attempt/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const body = await req.json().catch(() => null);

    const slug = body?.slug as string | undefined;
    const participant_name = body?.participant_name as string | undefined;
    const participant_user_id = body?.participant_user_id as string | undefined;
    const scoreRaw = body?.score;

    // participant_user_id is OPTIONAL now; others are required
    if (!slug || !participant_name || typeof scoreRaw !== "number") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid body fields" }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const score = Math.round(scoreRaw);

    // 1) Look up the share link to find the quiz + owner
    const { data: linkRow, error: linkErr } = await supabase
      .from("quiz_share_links")
      .select("user_id, quiz_id, is_enabled")
      .eq("slug", slug)
      .maybeSingle();

    if (linkErr || !linkRow || linkRow.is_enabled === false) {
      return new Response(
        JSON.stringify({ error: "Invalid or disabled share link" }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const ownerId = linkRow.user_id as string;
    const quizId = linkRow.quiz_id as string;

    // 2) Figure out the next attempt number
    //    If we have a participant_user_id (e.g. logged-in taker), key by that.
    //    Otherwise, key by participant_name so repeated attempts by the same name
    //    get Attempt 1, 2, 3, ...
    const attemptsQuery = supabase
      .from("quiz_share_attempts")
      .select("attempt_number")
      .eq("user_id", ownerId)
      .eq("quiz_id", quizId)
      .order("attempt_number", { ascending: false })
      .limit(1);

    if (participant_user_id) {
      attemptsQuery.eq("participant_user_id", participant_user_id);
    } else {
      attemptsQuery.eq("participant_name", participant_name);
    }

    const { data: lastAttempt, error: lastErr } = await attemptsQuery.maybeSingle();

    if (lastErr && lastErr.code !== "PGRST116") {
      // PGRST116 = no rows; not fatal
      console.error("Error reading last attempt:", lastErr);
    }

    const nextAttemptNumber =
      ((lastAttempt?.attempt_number as number | undefined) ?? 0) + 1;

    // 3) Insert a detailed attempt row
    const attemptPayload: Record<string, unknown> = {
      user_id: ownerId,
      quiz_id: quizId,
      participant_name,
      attempt_number: nextAttemptNumber,
      score,
    };

    // Only include participant_user_id if we actually have one
    if (participant_user_id) {
      attemptPayload.participant_user_id = participant_user_id;
    }

    const { error: insAttemptErr } = await supabase
      .from("quiz_share_attempts")
      .insert(attemptPayload);

    if (insAttemptErr) {
      console.error("Error inserting attempt:", insAttemptErr);
      return new Response(
        JSON.stringify({ error: "Failed to record attempt" }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // 4) Update / upsert the aggregate scoreboard row (quiz_share_scores)
    //    Only if we have a participant_user_id, since that is what your
    //    onConflict target uses.
    let newAttemptCount: number | null = null;

    if (participant_user_id) {
      const { data: existingScore } = await supabase
        .from("quiz_share_scores")
        .select("attempt_count")
        .eq("user_id", ownerId)
        .eq("quiz_id", quizId)
        .eq("participant_user_id", participant_user_id)
        .maybeSingle();

      newAttemptCount =
        ((existingScore?.attempt_count as number | undefined) ?? 0) + 1;

      const { error: upScoreErr } = await supabase
        .from("quiz_share_scores")
        .upsert(
          {
            user_id: ownerId,
            quiz_id: quizId,
            participant_user_id,
            participant_name,
            last_score: score,
            attempt_count: newAttemptCount,
            is_disabled: false,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "user_id,quiz_id,participant_user_id",
          },
        );

      if (upScoreErr) {
        console.error("Error upserting quiz_share_scores:", upScoreErr);
        // Not fatal for the attempt itself
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        attempt_number: nextAttemptNumber,
        attempt_count: newAttemptCount,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (e) {
    console.error("Unhandled error in record-shared-attempt:", e);
    return new Response(
      JSON.stringify({ error: "Unexpected error" }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
});
