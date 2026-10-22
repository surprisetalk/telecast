import { assertEquals, assertRejects } from "jsr:@std/assert";
import { extractYoutubeLinks, fromReddit, gather, linksFromHnHits, linksFromLectures, linksFromRedditListing } from "./seed.ts";

Deno.test("extractYoutubeLinks: pulls channel/handle/c/user forms, ignores videos", () => {
  const text = `
    check out https://www.youtube.com/channel/UCdBXOyqr8cDshsp7kcKDAkg and
    https://youtube.com/@SomeHandle_1 plus http://m.youtube.com/c/LegacyCustom
    and https://www.youtube.com/user/OldSchool — but NOT
    https://www.youtube.com/watch?v=dQw4w9WgXcQ nor https://youtu.be/abc123
  `;
  assertEquals(extractYoutubeLinks(text), [
    "https://www.youtube.com/channel/UCdBXOyqr8cDshsp7kcKDAkg",
    "https://www.youtube.com/@SomeHandle_1",
    "https://www.youtube.com/c/LegacyCustom",
    "https://www.youtube.com/user/OldSchool",
  ]);
});

Deno.test("extractYoutubeLinks: strips trailing punctuation and dedups", () => {
  const text = `(https://www.youtube.com/@foo), see https://www.youtube.com/@foo. again [https://www.youtube.com/@foo]`;
  assertEquals(extractYoutubeLinks(text), ["https://www.youtube.com/@foo"]);
});

Deno.test("extractYoutubeLinks: garbage in → empty out", () => {
  assertEquals(extractYoutubeLinks(""), []);
  assertEquals(extractYoutubeLinks("no links here, just prose about youtube.com in general"), []);
});

Deno.test("linksFromHnHits: reads url/title/story_text/comment_text, tolerates nulls", () => {
  const hits = [
    { url: "https://www.youtube.com/@storyChannel", title: null },
    { title: "loved https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa", url: "https://news.example.com" },
    { comment_text: "mirror at https://m.youtube.com/user/prof", story_text: null },
    { url: 42 },
    "not an object",
  ];
  assertEquals(linksFromHnHits(hits), [
    "https://www.youtube.com/@storyChannel",
    "https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa",
    "https://www.youtube.com/user/prof",
  ]);
  assertEquals(linksFromHnHits(null), []);
});

Deno.test("linksFromRedditListing: reads children url/title/selftext", () => {
  const json = {
    data: {
      children: [
        { data: { url: "https://www.youtube.com/@redditFind", title: "great channel", selftext: "" } },
        { data: { url: "https://reddit.com/r/x", selftext: "also https://www.youtube.com/c/Custom" } },
        { data: {} },
      ],
    },
  };
  assertEquals(linksFromRedditListing(json), [
    "https://www.youtube.com/@redditFind",
    "https://www.youtube.com/c/Custom",
  ]);
  assertEquals(linksFromRedditListing({}), []);
});

Deno.test("linksFromLectures: keeps http(s) urls verbatim, drops junk", () => {
  const json = [
    "https://www.youtube.com/@mitocw",
    "  https://example.edu/lectures/feed.xml  ",
    "not-a-url",
    42,
    "ftp://old/feed",
  ];
  assertEquals(linksFromLectures(json), [
    "https://www.youtube.com/@mitocw",
    "https://example.edu/lectures/feed.xml",
  ]);
  assertEquals(linksFromLectures("nope"), []);
});

Deno.test("gather: a source that throws fails the run, naming each; 0 links only warns", async () => {
  const ok = () => Promise.resolve(["https://www.youtube.com/@a"]);
  assertEquals(await gather([["hn", ok], ["lectures", () => Promise.resolve([])]]), ["https://www.youtube.com/@a"]);
  const err = await assertRejects(() =>
    gather([["hn", ok], ["reddit", () => Promise.reject(new Error("HTTP 429"))], ["lectures", () => Promise.reject(new Error("bad json"))]])
  );
  const msg = (err as Error).message;
  for (const part of ["reddit: HTTP 429", "lectures: bad json"]) assertEquals(msg.includes(part), true, `${part} missing from: ${msg}`);
  const odd = await assertRejects(() => gather([["a", () => Promise.reject("str")], ["b", () => Promise.reject(null)]]));
  assertEquals((odd as Error).message.startsWith("Seed sources failed: a: str; b: null."), true, (odd as Error).message);
});

Deno.test("fromReddit: missing credentials throw naming both variables and never their values", async () => {
  const env = (k: string) => k === "REDDIT_CLIENT_SECRET" ? "s3cret" : undefined;
  const err = await assertRejects(() => fromReddit(env, () => Promise.reject(new Error("no fetch expected"))));
  assertEquals(
    (err as Error).message,
    "Reddit credentials are missing. Expected REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env, from https://www.reddit.com/prefs/apps (type: script). Received: REDDIT_CLIENT_ID missing, REDDIT_CLIENT_SECRET set.",
  );
});

Deno.test("fromReddit: gets an app token with Basic auth, then searches with the bearer token", async () => {
  const env = (k: string) => ({ REDDIT_CLIENT_ID: "id1", REDDIT_CLIENT_SECRET: "sec2" })[k];
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/v1/access_token")) {
      return Promise.resolve(Response.json({ access_token: "tok", token_type: "bearer", expires_in: 86400 }));
    }
    return Promise.resolve(
      Response.json({ data: { children: [{ data: { url: "https://www.youtube.com/@ok", title: "", selftext: "" } }] } }),
    );
  };
  assertEquals(await fromReddit(env, fetcher as typeof fetch), [
    "https://www.youtube.com/@ok",
    "https://www.youtube.com/@ok",
    "https://www.youtube.com/@ok",
  ]);
  const [token, ...searches] = calls;
  const h = (c: { init: RequestInit }) => new Headers(c.init.headers);
  assertEquals([token!.init.method, h(token!).get("authorization"), String(token!.init.body)], [
    "POST",
    `Basic ${btoa("id1:sec2")}`,
    "grant_type=client_credentials",
  ]);
  assertEquals(
    searches.map((c) => [new URL(c.url).origin, h(c).get("authorization")]),
    Array(3).fill(["https://oauth.reddit.com", "bearer tok"]),
  );
  assertEquals(h(token!).get("user-agent"), "deno:telecast-seeder:1.1 (by telecast.company)");
});

Deno.test("fromReddit: a refused token names the status and the fix", async () => {
  const env = (k: string) => ({ REDDIT_CLIENT_ID: "id1", REDDIT_CLIENT_SECRET: "sec2" })[k];
  const fetcher = () => Promise.resolve(Response.json({ message: "Unauthorized" }, { status: 401 }));
  await assertRejects(
    () => fromReddit(env, fetcher as typeof fetch),
    Error,
    `Reddit token: expected HTTP 200 with a bearer access_token, received 401: {"message":"Unauthorized"}. Check the app's id and secret.`,
  );
});
