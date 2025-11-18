import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const maxDeletes = Number(Deno.env.get("MAX_DELETES") ?? 200);

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

serve(async (req) => {
  let age_hours = 24;
  try {
    const body = await req.json();
    if (body?.age_hours != null) age_hours = Number(body.age_hours);
  } catch { /* no body provided */ }

  const { data, error } = await admin.rpc("find_prunable_anon_users", { age_hours });
  if (error) {
    return new Response(JSON.stringify({ ok: false, error }), { status: 500 });
  }

  const ids: string[] = (data ?? []).map((r: { user_id: string }) => r.user_id);
  const toDelete = ids.slice(0, maxDeletes);

  let ok = 0, fail = 0;
  for (const id of toDelete) {
    const { error: delErr } = await admin.auth.admin.deleteUser(id);
    if (delErr) { fail++; }
    else { ok++; }
  }

  return new Response(
    JSON.stringify({ ok: true, age_hours, found: ids.length, deleted: ok, failed: fail }),
    { headers: { "content-type": "application/json" } }
  );
});
