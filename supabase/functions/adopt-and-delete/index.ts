// supabase/functions/adopt-and-delete/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// CORS helpers
function corsHeaders(req: Request): Headers {
  const h = new Headers();
  const origin = req.headers.get("Origin") ?? "*";
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Vary", "Origin");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  // IMPORTANT: allow the headers Supabase client sends
  h.set(
    "Access-Control-Allow-Headers",
    "authorization, x-client-info, apikey, content-type",
  );
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

serve(async (req) => {
  const t0 = performance.now();
  const cors = corsHeaders(req);

  // Preflight
  if (req.method === "OPTIONS") {
    console.log("[adopt] OPTIONS from", req.headers.get("Origin"));
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    console.log("[adopt] START", {
      method: req.method,
      origin: req.headers.get("Origin"),
      hasAuth: !!req.headers.get("Authorization"),
      xClientInfo: req.headers.get("x-client-info") ?? null,
    });

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST required" }), {
        status: 405,
        headers: cors,
      });
    }

    const body = await req.json().catch(() => ({}));
    const old_id: string | undefined = body?.old_id;
    console.log("[adopt] body:", body);

    if (!old_id) {
      return new Response(JSON.stringify({ error: "old_id required" }), {
        status: 400,
        headers: cors,
      });
    }

    // Caller-scoped client (uses caller's JWT)
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });

    // Must be authenticated (the new real user)
    const me = await userClient.auth.getUser();
    const newUser = me.data.user;
    if (!newUser) {
      console.log("[adopt] unauthorized");
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: cors,
      });
    }
    console.log("[adopt] newUser.id:", newUser.id, "old_id:", old_id);

    // 1) Move rows via SECURITY DEFINER RPC
    const rpcStart = performance.now();
    const { data: rpcData, error: rpcErr } = await userClient.rpc("adopt_guest", {
      p_old_user: old_id,
    });
    console.log("[adopt] RPC adopt_guest result:", { rpcData, rpcErr, ms: Math.round(performance.now() - rpcStart) });
    if (rpcErr) {
      return new Response(JSON.stringify({ error: rpcErr.message }), {
        status: 400,
        headers: cors,
      });
    }

    // 2) Delete old anonymous user (service role)
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const getOld = await admin.auth.admin.getUserById(old_id);
    console.log("[adopt] getUserById:", {
      error: getOld.error?.message ?? null,
      found: !!getOld.data?.user,
    });

    let deleted = false;
    let deleteWarn: string | null = null;

    if (getOld.data?.user) {
      const app = getOld.data.user.app_metadata ?? {};
      const providers: string[] = Array.isArray(app.providers) ? app.providers : [];
      const provider = app.provider as string | undefined;
      const isAnon = provider === "anonymous" || providers.includes("anonymous");

      if (isAnon) {
        const delStart = performance.now();
        const delRes = await admin.auth.admin.deleteUser(old_id);
        deleted = !delRes.error;
        deleteWarn = delRes.error?.message ?? null;
        console.log("[adopt] deleteUser:", {
          deleted,
          deleteWarn,
          ms: Math.round(performance.now() - delStart),
        });
      } else {
        console.log("[adopt] old_id is NOT anonymous; skipping delete.");
      }
    } else {
      console.log("[adopt] old user not found; skipping delete.");
    }

    const ms = Math.round(performance.now() - t0);
    return new Response(
      JSON.stringify({
        ok: true,
        new_user_id: newUser.id,
        old_id,
        rpc: rpcData ?? null,
        deleted_old_user: deleted,
        delete_warn: deleteWarn,
        ms,
      }),
      { status: 200, headers: cors },
    );
  } catch (e) {
    console.error("[adopt] FATAL:", e);
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
      status: 500,
      headers: cors,
    });
  }
});
