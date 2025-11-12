// supabase/functions/adopt-and-delete/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  // --- CORS ---
  const origin = req.headers.get("Origin") ?? "*";
  const CORS = {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-client",
    "Access-Control-Max-Age": "86400",
  };
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

  const t0 = Date.now();
  try {
    const { old_id } = await req.json().catch(() => ({}));
    console.log("[adopt] start", { old_id, method: req.method, path: new URL(req.url).pathname });

    if (!old_id) {
      console.warn("[adopt] missing old_id");
      return json({ error: "old_id required" }, 400);
    }

    // Client-scoped (caller’s JWT)
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });

    const me = await userClient.auth.getUser();
    if (!me.data.user) {
      console.warn("[adopt] unauthorized (no user)");
      return json({ error: "unauthorized" }, 401);
    }
    const newId = me.data.user.id;
    console.log("[adopt] caller", { newId });

    // Move rows
    const { data: adoptData, error: adoptErr } = await userClient.rpc("adopt_guest", { p_old_user: old_id });
    if (adoptErr) {
      console.error("[adopt] adopt_guest error", adoptErr);
      return json({ error: adoptErr.message }, 400);
    }
    console.log("[adopt] adopt_guest ok", adoptData ?? null);

    // Admin delete if the old user is anonymous
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: oldUser, error: getErr } = await admin.auth.admin.getUserById(old_id);
    if (getErr) {
      console.error("[adopt] getUserById error", getErr);
      return json({ error: getErr.message }, 400);
    }

    const meta = oldUser?.user?.app_metadata ?? {};
    const providers: string[] = Array.isArray(meta.providers) ? meta.providers : [];
    const isAnon = meta.provider === "anonymous" || providers.includes("anonymous");
    console.log("[adopt] old user meta", { isAnon, providers, provider: meta.provider });

    let deleted = false;
    let deleteWarn: string | undefined;

    if (isAnon) {
      const del = await admin.auth.admin.deleteUser(old_id);
      if (del.error) {
        deleteWarn = del.error.message;
        console.warn("[adopt] deleteUser warn", deleteWarn);
      } else {
        deleted = true;
        console.log("[adopt] deleteUser ok");
      }
    } else {
      console.log("[adopt] old user not anonymous; skip delete");
    }

    const ms = Date.now() - t0;
    return json({ ok: true, moved: adoptData ?? null, deleted, warn: deleteWarn, ms });
  } catch (e) {
    console.error("[adopt] fatal", e);
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
