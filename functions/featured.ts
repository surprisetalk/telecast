import db from "postgres";
import type { Env } from "./env";

// Keep in sync with `discoverTags` in src/Main.elm.
const CATEGORIES = [
  "featured",
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
  "comedy",
  "vtubers",
];

const QUALITY_MIN = 30;
const PER_CATEGORY = 12;

export async function onRequest({ env }: { env: Env }) {
  const sql = db(env.DATABASE_URL!);
  try {
    const rows = await sql`
      with ranked as (
        select c.*,
          coalesce(
            (select thumb from episode e
             where e.channel_id = c.channel_id and e.thumb is not null
               and not (lower(coalesce(title,'')) like '%#shorts%'
                     or lower(coalesce(title,'')) like '%#short%'
                     or lower(coalesce(description,'')) like '%#shorts%'
                     or lower(coalesce(description,'')) like '%#short%'
                     or coalesce(link,'') like '%/shorts/%')
             order by published_at desc nulls last limit 1),
            (select thumb from episode e
             where e.channel_id = c.channel_id and e.thumb is not null
             order by published_at desc nulls last limit 1)
          ) as episode_thumb,
          t.tag,
          row_number() over (partition by t.tag order by c.quality desc, random()) as rn
        from channel c
        join unnest(coalesce(c.tags, '{}')) t(tag) on true
        where t.tag = any(${CATEGORIES})
          and c.quality >= ${QUALITY_MIN}
      )
      select * from ranked where rn <= ${PER_CATEGORY} order by tag, rn
    `;
    const out: Record<string, unknown[]> = {};
    for (const cat of CATEGORIES) out[cat] = [];
    for (const r of rows) {
      const { tag, rn, ...rest } = r as Record<string, unknown>;
      (out[tag as string] ??= []).push(rest);
    }
    return new Response(JSON.stringify(out), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Featured query failed: ${message}`);
    return new Response(`Featured failed: ${message}`, { status: 502 });
  }
}
