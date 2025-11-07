// supabase/functions/delete-account/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      console.error(
        "Missing one of SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY",
      );
      return new Response("Server misconfigured", {
        status: 500,
        headers: corsHeaders,
      });
    }

    // --- 1) Handle CORS preflight (no auth needed here) ---
    if (req.method === "OPTIONS") {
      return new Response("ok", {
        status: 200,
        headers: corsHeaders,
      });
    }

    if (req.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: corsHeaders,
      });
    }

    // --- 2) Read access token from body (sent by frontend) ---
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const accessToken = body?.accessToken;
    if (!accessToken || typeof accessToken !== "string") {
      console.error("Missing accessToken in request body");
      return new Response("Missing access token", {
        status: 401,
        headers: corsHeaders,
      });
    }

    // --- 3) Use anon key + provided token to identify the user ---
    const userClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    });

    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();

    if (userErr || !user) {
      console.error("getUser error", userErr);
      return new Response("Unauthorized", {
        status: 401,
        headers: corsHeaders,
      });
    }

    const userId = user.id;
    console.log("Deleting account for user", userId);

    // --- 4) Use service role to delete all their data ---
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const tableDeletes = [
      adminClient.from("quiz_scores").delete().eq("user_id", userId),
      adminClient.from("group_scores").delete().eq("user_id", userId),
      adminClient.from("quizzes").delete().eq("user_id", userId),
      adminClient.from("groups").delete().eq("user_id", userId),
    ];

    for (const op of tableDeletes) {
      const { error } = await op;
      if (error && error.code !== "PGRST116") {
        console.error("Table delete error", error);
        return new Response("Failed to delete data", {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    // --- 5) Delete the auth user ---
    const { error: delErr } = await adminClient.auth.admin.deleteUser(userId);
    if (delErr) {
      console.error("deleteUser error", delErr);
      return new Response("Failed to delete user", {
        status: 500,
        headers: corsHeaders,
      });
    }

    console.log("Account deleted for user", userId);

    return new Response("OK", {
      status: 200,
      headers: corsHeaders,
    });
  } catch (e) {
    console.error("Unhandled error in delete-account", e);
    return new Response("Server error", {
      status: 500,
      headers: corsHeaders,
    });
  }
});
