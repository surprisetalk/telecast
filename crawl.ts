const PI_KEY = "TWTGLQDR8H7LKHYUURNT";
const PI_SECRET = "QKVK$k2TSSae9vRyCHqV9sKj^$tUP2bpHekd2CKf";

let since = 0, count = 0;
do {

  console.log(new Date(since))

const time = Math.floor(Date.now() / 1000);
const hash = await crypto.subtle
  .digest("SHA-1", new TextEncoder().encode(PI_KEY + PI_SECRET + time))
  .then((buf) =>
    Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(""),
  );

  const response = await fetch(
    `https://api.podcastindex.org/api/1.0/recent/feeds?max=100&since=${since}`,
    {
      headers: {
        "X-Auth-Date": time.toString(),
        "X-Auth-Key": PI_KEY,
        Authorization: hash,
        "User-Agent": "Telecast/1.0",
      },
    },
  );

  const data = await response.json();

  console.log(data)

  await Deno.writeTextFile(`feeds/${since}.json`, JSON.stringify(data.feeds,null,2));

  since = parseInt(data.since ?? "0");
  count = data.count;

  break;

} while (count) 
