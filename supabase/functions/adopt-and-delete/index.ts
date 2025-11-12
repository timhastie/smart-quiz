// supabase/functions/adopt-and-delete/index.ts
// Edge function to ADOPT data from an old guest (old_id) into the CURRENT caller,
// then (optionally) delete the old anonymous auth user.
// - Verifies caller from Authorization header
// - Logs EVERYTHING to function logs
// - Captures per-table counts before/after
//
// Body:
//   {
//     "old_id": "uuid-of-guest",
//     "delete_old_auth": true  // optional (default true)
//   }
//
// Returns JSON summary with steps, counts, and any errors.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type TableName = "groups" | "quizzes" | "quiz_scores" | "group_scores";
const TABLES: TableName[] = ["groups", "quizzes", "quiz_scores", "group_scores"];

// ---- helpers ---------------------------------------------------------------

function j(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function countRowsForUser(admin: ReturnType<typeof createClient>, table: TableName, userId: string) {
  const t0 = Date.now();
  const { count, error } = await admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  const ms = Date.now() - t0;
  if (error) {
    console.error(`[adopt][count] ${table} user=${userId} ERROR:`, error.message);
    return { table, userId, count: null as number | null, ms, error: error.message };
  }
  console.log(`[adopt][count] ${table} user=${userId} -> ${count} rows (${ms}ms)`);
  return { table, userId, count: count ?? 0, ms, error: null as string | null };
}

// ---- server ----------------------------------------------------------------

serve(async (req) => {
  const startedAt = Date.now();
  const path = new URL(req.url).pathname;
  console.log("[adopt] START", { path, method: req.method });

  try {
    const ct = req.headers.get("content-type") || "";
    const hasAuth = !!req.headers.get("Authorization");
    console.log("[adopt] headers", { content_type: ct, hasAuthorization: hasAuth });

    let body: any = {};
    try {
      body = ct.includes("application/json") ? await req.json() : {};
    } catch (e) {
      console.warn("[adopt] body parse warning:", String(e));
    }

    const old_id = String(body?.old_id || "");
    const delete_old_auth = body?.delete_old_auth !== false; // default true
    if (!old_id) {
      console.error("[adopt] missing old_id");
      return j(400, { ok: false, error: "old_id required" });
    }

    // 1) Authenticated caller (destination user)
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const me = await userClient.auth.getUser();
    if (me.error || !me.data.user?.id) {
      console.error("[adopt] unauthorized or token invalid:", me.error?.message);
      return j(401, { ok: false, error: "unauthorized", detail: me.error?.message || null });
    }
    const new_id = me.data.user.id;
    console.log("[adopt] caller", { new_id, old_id, delete_old_auth });

    if (new_id === old_id) {
      console.log("[adopt] same IDs; nothing to do");
      return j(200, { ok: true, note: "new_id equals old_id; no adoption needed" });
    }

    // 2) Admin client for counts & deletes
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // 2a) Capture PRE-COUNTS
    console.log("[adopt] counting rows BEFORE adopt");
    const preCounts = await Promise.all([
      ...TABLES.map((t) => countRowsForUser(admin, t, old_id)),
      ...TABLES.map((t) => countRowsForUser(admin, t, new_id)),
    ]);

    // 3) Move data via SECURITY DEFINER RPC (server-side ownership change)
    //     adopt_guest(p_old_user uuid)
    console.log("[adopt] RPC adopt_guest BEGIN", { p_old_user: old_id, to_user: new_id });
    const tRpc = Date.now();
    const { error: adoptErr } = await userClient.rpc("adopt_guest", { p_old_user: old_id });
    const rpcMs = Date.now() - tRpc;

    if (adoptErr) {
      console.error("[adopt] RPC adopt_guest ERROR:", adoptErr.message);
      return j(400, {
        ok: false,
        step: "adopt_guest",
        ms: rpcMs,
        error: adoptErr.message,
        preCounts,
      });
    }
    console.log("[adopt] RPC adopt_guest OK", { ms: rpcMs });

    // 4) Capture POST-COUNTS
    console.log("[adopt] counting rows AFTER adopt");
    const postCounts = await Promise.all([
      ...TABLES.map((t) => countRowsForUser(admin, t, old_id)),
      ...TABLES.map((t) => countRowsForUser(admin, t, new_id)),
    ]);

    // 5) Optionally delete old anonymous auth user
    let deleteStep: { tried: boolean; deleted: boolean; error?: string | null } = {
      tried: false,
      deleted: false,
      error: null,
    };

    if (delete_old_auth) {
      console.log("[adopt] check old auth user type BEFORE delete");
      const { data: oldUser, error: getErr } = await admin.auth.admin.getUserById(old_id);
      if (getErr) {
        console.warn("[adopt] getUserById warning (continuing):", getErr.message);
        deleteStep = { tried: true, deleted: false, error: getErr.message };
      } else {
        const isAnon =
          !!oldUser?.user &&
          (oldUser.user.app_metadata?.provider === "anonymous" ||
            (Array.isArray(oldUser.user.app_metadata?.providers) &&
              oldUser.user.app_metadata.providers.includes("anonymous")));

        console.log("[adopt] old user app_metadata", {
          provider: oldUser?.user?.app_metadata?.provider,
          providers: oldUser?.user?.app_metadata?.providers,
          isAnon,
        });

        if (isAnon) {
          console.log("[adopt] deleting old anonymous auth user...");
          const delRes = await admin.auth.admin.deleteUser(old_id).catch((e: any) => ({
            error: { message: String(e?.message || e) },
          })) as any;

          if (delRes?.error) {
            console.warn("[adopt] deleteUser warning (not fatal):", delRes.error.message);
            deleteStep = { tried: true, deleted: false, error: delRes.error.message };
          } else {
            console.log("[adopt] deleteUser OK");
            deleteStep = { tried: true, deleted: true, error: null };
          }
        } else {
          console.log("[adopt] old user is not anonymous; skip delete.");
          deleteStep = { tried: true, deleted: false, error: "old_user_not_anonymous" };
        }
      }
    } else {
      console.log("[adopt] delete_old_auth=false; skipping deletion step.");
    }

    const ms = Date.now() - startedAt;
    console.log("[adopt] DONE", { ms, new_id, old_id, deleteStep });

    return j(200, {
      ok: true,
      ms,
      new_id,
      old_id,
      preCounts,
      postCounts,
      deleteStep,
    });
  } catch (e: any) {
    console.error("[adopt] FATAL", e?.message || String(e));
    return j(500, { ok: false, error: e?.message || String(e) });
  }
});
