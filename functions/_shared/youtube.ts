export async function preferUulfFeedUrl(ucId: string, fetcher: typeof fetch): Promise<string> {
  const uulf = `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${ucId.slice(2)}`;
  try {
    const res = await fetcher(uulf, { method: "HEAD" });
    if (res.ok) return uulf;
  } catch { /* fall through to channel_id form */ }
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${ucId}`;
}

export async function resolveYoutubeFeedUrl(rawUrl: string, fetcher: typeof fetch): Promise<{ url: string } | { error: string }> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { url: rawUrl };
  }
  if (!/(^|\.)youtube\.com$/.test(u.hostname)) return { url: rawUrl };
  if (u.pathname.startsWith("/feeds/")) {
    const cid = u.searchParams.get("channel_id");
    if (cid && /^UC[\w-]+$/.test(cid)) return { url: await preferUulfFeedUrl(cid, fetcher) };
    return { url: rawUrl };
  }
  const channelMatch = u.pathname.match(/^\/channel\/(UC[\w-]+)/);
  if (channelMatch) return { url: await preferUulfFeedUrl(channelMatch[1]!, fetcher) };
  const isHandle = u.pathname.startsWith("/@") || u.pathname.startsWith("/c/") || u.pathname.startsWith("/user/");
  if (!isHandle) return { url: rawUrl };
  const pageUrl = `https://www.youtube.com${u.pathname}`;
  const res = await fetcher(pageUrl, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) return { error: `Failed to resolve YouTube handle page ${pageUrl}: HTTP ${res.status} ${res.statusText}` };
  const html = await res.text();
  const patterns = [
    /"channelId":"(UC[\w-]+)"/,
    /"externalId":"(UC[\w-]+)"/,
    /"browseId":"(UC[\w-]+)"/,
    /<link rel="canonical" href="https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[\w-]+)"/,
    /<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]+)"/,
    /\/channel\/(UC[\w-]+)/,
  ];
  let id: string | undefined;
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      id = m[1];
      break;
    }
  }
  if (!id) {
    const snippet = html.slice(0, 200).replace(/\s+/g, " ").trim();
    return {
      error:
        `Could not extract channelId from ${pageUrl} (HTML ${html.length} bytes). Tried 6 patterns including "channelId":"UC...", canonical link, /channel/UC... sweep. First 200 chars: ${snippet}`,
    };
  }
  return { url: await preferUulfFeedUrl(id, fetcher) };
}
