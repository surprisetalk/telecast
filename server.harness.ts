// Boots server.ts with the flags of `deno task serve`, for server.test.ts and functions/_shared/budget.test.ts.
export const ROOT = import.meta.dirname!;
const START_TIMEOUT_MS = 20_000;
// pc's socket form. /run/postgresql/.s.PGSQL.5432 is missing here, so /search reaches postgres.js, which fails without a
// database, and Deno's permissions for the socket path get checked as on pc.
export const NO_DB = { DATABASE_URL: "postgres:///telecast", PGHOST: "/run/postgresql", PGUSER: "telecast", PGPASSWORD: "x" };

// Starts the server with the flags of `deno task serve`, minus .env and on a free port, so the suite checks its permissions.
export function serve(env: Record<string, string>) {
  const task: string = JSON.parse(Deno.readTextFileSync(`${ROOT}/deno.json`)).tasks.serve;
  const args = task.split(" ").slice(1).filter((a) => a !== "--env-file=.env").map((a) => a === "--port=8047" ? "--port=0" : a);
  return new Deno.Command(Deno.execPath(), {
    args,
    cwd: ROOT,
    clearEnv: true,
    // telecast-web on pc sets LD_LIBRARY_PATH, so sharp's addon finds libstdc++ on NixOS.
    env: { HOME: Deno.env.get("HOME")!, PATH: Deno.env.get("PATH")!, LD_LIBRARY_PATH: Deno.env.get("LD_LIBRARY_PATH") ?? "", ...env },
    stdout: "null",
    stderr: "piped",
  }).spawn();
}

// systemd waits 90 s after SIGTERM, then kills the unit. Until the server exits, cloudflared answers every visitor 502.
const STOP_TIMEOUT_MS = 5_000;

// Boots the server and returns its base URL, its stderr so far, and a stop function that sends SIGTERM as systemd does.
export async function boot(env: Record<string, string>) {
  const child = serve(env);
  let log = "";
  const reading = (async () => {
    for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) log += chunk;
  })();
  let exited = false;
  child.status.then(() => exited = true);
  const t0 = performance.now();
  let base: string | undefined;
  while (!base) {
    if (exited) throw new Error(`Server exited before it listened. stderr: ${log}`);
    if (performance.now() - t0 > START_TIMEOUT_MS) throw new Error(`Server did not listen within ${START_TIMEOUT_MS} ms. stderr: ${log}`);
    base = log.match(/Listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    base,
    log: () => log,
    async stop() {
      const t0 = performance.now();
      if (!exited) child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
      await child.status;
      clearTimeout(kill);
      await reading;
      const ms = Math.round(performance.now() - t0);
      if (ms >= STOP_TIMEOUT_MS) {
        throw new Error(`Expected the server to exit within ${STOP_TIMEOUT_MS} ms of SIGTERM, received ${ms} ms. stderr: ${log}`);
      }
    },
  };
}

// Streams ?bytes= bytes of text in 100 KB chunks, counts the responses that sent all of them, then waits for release.
export function stallingUpstream(release: Promise<void>) {
  const counter = { sent: 0 };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
    let left = Number(new URL(req.url).searchParams.get("bytes"));
    const chunk = new TextEncoder().encode("x".repeat(100_000));
    return new Response(
      new ReadableStream({
        async pull(c) {
          if (left > 0) {
            left -= chunk.length;
            c.enqueue(chunk);
            return;
          }
          counter.sent++;
          await release;
          c.close();
        },
      }),
    );
  });
  const url = (i: number, bytes: number) => `http://127.0.0.1:${server.addr.port}/f${i}?bytes=${bytes}`;
  const sentAll = async (n: number) => {
    const t0 = performance.now();
    while (counter.sent < n) {
      if (performance.now() - t0 > 10_000) throw new Error(`Expected ${n} feeds fully sent, received ${counter.sent} after 10 s.`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { server, url, sentAll };
}
