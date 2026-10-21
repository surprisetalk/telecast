import db from "postgres";

type Curation = { priority: string[]; blocked: string[] };
type ChannelRow = { channel_id: string; tags: string[] | null };

export function selectFeatured(c: Curation): string[] {
  const blocked = new Set(c.blocked);
  return [...new Set(c.priority.filter((id) => !blocked.has(id)))].sort();
}

function reqStrArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`curation.json: ${field} must be string[], got ${JSON.stringify(v)}`);
  }
  return v as string[];
}

async function loadCuration(): Promise<Curation> {
  const raw = JSON.parse(await (await fetch(new URL("./curation.json", import.meta.url))).text());
  for (const k of Object.keys(raw)) {
    if (k !== "priority" && k !== "blocked") {
      throw new Error(`curation.json: unknown key "${k}"; expected only "priority" and "blocked". Remove it.`);
    }
  }
  return {
    priority: reqStrArray(raw.priority, "priority"),
    blocked: reqStrArray(raw.blocked, "blocked"),
  };
}

async function main() {
  const dryRun = Deno.args.includes("--dry-run");
  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    console.error("DATABASE_URL not set");
    Deno.exit(1);
  }

  const c = await loadCuration();
  const sql = db(databaseUrl, { idle_timeout: 20, connect_timeout: 30 });

  const rows: ChannelRow[] = (await sql`select channel_id, tags from channel`)
    .map((r: any) => ({ channel_id: r.channel_id, tags: r.tags }));

  const target = new Set(selectFeatured(c));
  const current = new Set(rows.filter((r) => (r.tags ?? []).includes("featured")).map((r) => r.channel_id));
  const toAdd = [...target].filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !target.has(id));

  console.log(
    `${rows.length} channels · ${current.size} featured now → ${target.size} target ` +
      `(priority ${c.priority.length}, blocked ${c.blocked.length})`,
  );
  console.log(`  +${toAdd.length} to add, -${toRemove.length} to remove`);
  if (toAdd.length) console.log(`  add: ${toAdd.slice(0, 10).join(", ")}${toAdd.length > 10 ? " …" : ""}`);
  if (toRemove.length) console.log(`  remove: ${toRemove.slice(0, 10).join(", ")}${toRemove.length > 10 ? " …" : ""}`);

  if (dryRun) {
    console.log("\n(dry run — no writes)");
    await sql.end();
    return;
  }

  let added = 0;
  let removed = 0;
  if (toAdd.length) {
    const r = await sql`
      update channel
      set tags = (select array_agg(distinct t) from unnest(coalesce(tags, '{}') || array['featured']) t)
      where channel_id = any(${toAdd})
      returning channel_id
    `;
    added = r.length;
  }
  if (toRemove.length) {
    const r = await sql`update channel set tags = array_remove(tags, 'featured') where channel_id = any(${toRemove}) returning channel_id`;
    removed = r.length;
  }

  if (added !== toAdd.length) console.warn(`  note: ${toAdd.length - added} priority id(s) matched no channel row (dead pick?)`);
  console.log(`\nDone: +${added} / -${removed}`);
  await sql.end();
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    Deno.exit(1);
  });
}
