import db from "postgres";
import type { Env } from "./env";

// Manual curation knob — append channel_ids to exclude from featured picks.
const BLOCKED_CHANNEL_IDS: string[] = [
  // Sensational, sponsored, or off-theme
  "UCbfYPyITQ-7l4upoX8nvctg", // Two Minute Papers — AI hype, mis-tagged physics
  "UCRlICXvO4XR4HMeEB9JjDlA", // Thoughty2 — clickbait pop-history
  "UCZdGJgHbmqQcVZaJCkqDRwg", // The Q — sponsored vacuum reviews
  "UC513PdAP2-jWkJunTh5kXRw", // CrunchLabs — promo content under makers
  "UCZ03CytzVCaij-HXhFdMHeg", // Manime Matt — sensational dating content
  "UCaN8DZdc8EHo5y1LsQWMiig", // Big Joel — sensational framing
  "UCFL15pr0h8iZYNB22jHu0zQ", // Stoccafisso design — off-theme under architecture
  "UCY1kMZp36IQSyNx_9h4mpCg", // Mark Rober — explicit #TidePartner sponcon
  "UCvlj0IzjSnNoduQF0l3VGng", // Some More News — partisan in video-essays
  "UCRDDHLvQb8HjE2r7_ZuNtWA", // Signals Music Studio — clickbait framing
  "UC0k238zFx-Z8xFH0sxCrPJg", // Architectural Digest — celebrity-home format
  // Tag mis-assignments (fix in DB eventually)
  "UCiBRvd_WgBNiq0CPmCVSFGw", // Alfo Media — music content tagged anime
  "b2825df0-acde-5eae-af33-f12c63cc0f1e", // Memorizing Pharmacology — podcast tagged chemistry
  "7869bf2a-50e6-5bf0-adf0-965e7e50db3e", // Chromatography Experts — vendor podcast tagged chemistry
  "UCnDZwUFMzqOBcF3bjRfZD-g", // Cocoro Ch by ロート製薬 — corporate mascot tagged vtubers
];

const CLICKBAIT_PATTERNS = [
  "%gets laid%",
  "% insane %",
  "% crazy %",
  "% destroys %",
  "% destroyed %",
  "% exposed %",
  "% reacts %",
  "% reaction %",
  "%you won't believe%",
  "% vs the world%",
  "% goes wrong%",
];

// Keep in sync with `discoverTags` in src/Main.elm.
// `comedy` intentionally omitted — tag pool is dominated by PodcastIndex
// imports whose quality scores rank above real comedy YouTube creators.
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
  "vtubers",
];

const QUALITY_MIN = 50;
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
                     or coalesce(link,'') like '%/shorts/%'
                     or coalesce(title,'') ilike any(${CLICKBAIT_PATTERNS}))
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
          and c.channel_id <> all(${BLOCKED_CHANNEL_IDS})
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
