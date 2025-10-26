// supabase/functions/adopt-and-delete/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  try {
    const { old_id } = await req.json();
    if (!old_id) return new Response(JSON.stringify({ error: "old_id required" }), { status: 400 });

    // 1) User-scoped client (uses caller's JWT) -> run adopt_guest
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });

    // Must be authenticated
    const me = await userClient.auth.getUser();
    if (!me.data.user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

    // Move data (your SECURITY DEFINER function)
    const { error: adoptErr } = await userClient.rpc("adopt_guest", { p_old_user: old_id });
    if (adoptErr) return new Response(JSON.stringify({ error: adoptErr.message }), { status: 400 });

    // 2) Admin client -> delete the old anonymous user
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // safety check: only delete if the old user is actually anonymous
    const { data: oldUser, error: getErr } = await admin.auth.admin.getUserById(old_id);
    if (getErr) return new Response(JSON.stringify({ error: getErr.message }), { status: 400 });

    const isAnon =
      oldUser?.user &&
      (oldUser.user.app_metadata?.provider === "anonymous" ||
       (Array.isArray(oldUser.user.app_metadata?.providers) &&
        oldUser.user.app_metadata.providers.includes("anonymous")));

    if (!isAnon) {
      // Don’t delete non-anonymous accounts
      return new Response(JSON.stringify({ ok: true, deleted: false }), { status: 200 });
    }

    const delRes = await admin.auth.admin.deleteUser(old_id);
    if (delRes.error) {
      // Not fatal for the user; just report
      return new Response(JSON.stringify({ ok: true, deleted: false, warn: delRes.error.message }), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: true, deleted: true }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 500 });
  }
});
