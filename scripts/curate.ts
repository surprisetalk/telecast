import db from "postgres";

// Topic tags that get auto-promoted to `featured` (mirrors discoverTags in
// src/Main.elm plus the coarse tags the refresh pipeline infers).
const TOPIC_TAGS = [
  "conferences",
  "systems",
  "creative-coding",
  "math",
  "physics",
  "chemistry",
  "engineering",
  "electronics",
  "makers",
  "woodworking",
  "restoration",
  "music-theory",
  "music-production",
  "synthesizers",
  "musicians",
  "film-essays",
  "game-design",
  "game-essays",
  "video-essays",
  "anime",
  "urbanism",
  "architecture",
  "gardening",
  "cooking",
  "coffee",
  "tiny-living",
  "retro-tech",
  "speedrunning",
  "ttrpg",
  "vtubers",
  "technology",
  "games",
  "food",
  "fitness",
  "science",
  "history",
  "music",
  "news",
  "politics",
  "film",
  "arts",
  "business",
  "health",
  "education",
  "comedy",
  "religion",
];

type Curation = { perTagLimit: number; minQuality: number; featuredPin: string[]; blocked: string[] };
type ChannelRow = { channel_id: string; tags: string[] | null; quality: number };

// Pure: given all channels, pick the featured set — top-N per topic tag by
// quality, plus pins, minus blocked. Deterministic (quality desc, id asc).
export function selectFeatured(rows: ChannelRow[], c: Curation): string[] {
  const blocked = new Set(c.blocked);
  const featured = new Set<string>();
  for (const tag of TOPIC_TAGS) {
    rows
      .filter((r) => (r.tags ?? []).includes(tag) && r.quality >= c.minQuality && !blocked.has(r.channel_id))
      .sort((a, b) => b.quality - a.quality || a.channel_id.localeCompare(b.channel_id))
      .slice(0, c.perTagLimit)
      .forEach((r) => featured.add(r.channel_id));
  }
  for (const id of c.featuredPin) if (!blocked.has(id)) featured.add(id);
  return [...featured].sort();
}

function reqNum(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`curation.json: ${field} must be a number, got ${JSON.stringify(v)}`);
  return v;
}

function reqStrArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`curation.json: ${field} must be string[], got ${JSON.stringify(v)}`);
  }
  return v as string[];
}

async function loadCuration(): Promise<Curation> {
  const raw = JSON.parse(await (await fetch(new URL("./curation.json", import.meta.url))).text());
  return {
    perTagLimit: reqNum(raw.perTagLimit, "perTagLimit"),
    minQuality: reqNum(raw.minQuality, "minQuality"),
    featuredPin: reqStrArray(raw.featuredPin, "featuredPin"),
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

  const rows: ChannelRow[] = (await sql`select channel_id, tags, quality from channel`)
    .map((r: any) => ({ channel_id: r.channel_id, tags: r.tags, quality: r.quality }));

  const target = new Set(selectFeatured(rows, c));
  const current = new Set(rows.filter((r) => (r.tags ?? []).includes("featured")).map((r) => r.channel_id));
  const toAdd = [...target].filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !target.has(id));

  console.log(
    `${rows.length} channels · ${current.size} featured now → ${target.size} target ` +
      `(perTag ${c.perTagLimit}, minQuality ${c.minQuality}, pin ${c.featuredPin.length}, blocked ${c.blocked.length})`,
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

  if (added !== toAdd.length) console.warn(`  note: ${toAdd.length - added} pinned id(s) matched no channel row (dead pin?)`);
  console.log(`\nDone: +${added} / -${removed}`);
  await sql.end();
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    Deno.exit(1);
  });
}
