// supabase/functions/adopt-and-delete/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Allow production + local dev */
const ALLOW_ORIGINS = new Set([
  "https://www.smart-quiz.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function corsHeaders(origin: string | null) {
  const o = origin && ALLOW_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": o, // empty string -> no wildcard; OK for preflight read
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-client",
    "Vary": "Origin",
  };
}

serve(async (req) => {
  const origin = req.headers.get("Origin");
  const baseHeaders = corsHeaders(origin);

  // Always answer preflight nicely
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  try {
    const { old_id } = await req.json().catch(() => ({}));
    if (!old_id) {
      return new Response(JSON.stringify({ error: "old_id required" }), {
        status: 400,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
      });
    }

    // Caller’s JWT client (runs SECURITY DEFINER RPC)
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });

    const me = await userClient.auth.getUser();
    if (!me.data.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
      });
    }

    const newUserId = me.data.user.id;

    // Run your SECURITY DEFINER RPC to move rows
    const rpc = await userClient.rpc("adopt_guest", { p_old_user: old_id });
    if (rpc.error) {
      return new Response(JSON.stringify({ error: rpc.error.message }), {
        status: 400,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
      });
    }

    // Admin delete of old anon (best-effort)
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const getOld = await admin.auth.admin.getUserById(old_id);
    let deleted = false;
    let deleteWarn: string | undefined;

    if (!getOld.error) {
      const u = getOld.data.user;
      const isAnon =
        u?.app_metadata?.provider === "anonymous" ||
        (Array.isArray(u?.app_metadata?.providers) &&
         u!.app_metadata!.providers.includes("anonymous"));

      if (isAnon) {
        const del = await admin.auth.admin.deleteUser(old_id);
        if (del.error) {
          deleteWarn = del.error.message;
        } else {
          deleted = true;
        }
      }
    }

    const body = {
      ok: true,
      new_user_id: newUserId,
      old_id,
      rpc: rpc.data ?? null, // surface any row counts your function returns
      deleted_old_user: deleted,
      delete_warn: deleteWarn,
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
      status: 500,
      headers: { ...corsHeaders(req.headers.get("Origin")), "Content-Type": "application/json" },
    });
  }
});
