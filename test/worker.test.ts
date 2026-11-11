import { describe, expect, it } from "vitest";
import { WINDOW_MS } from "../src/config";
import worker, { type Env } from "../src/index";

const FILES: Record<string, string> = {
  "/bbb/vod.m3u8": `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360
360p/vod.m3u8
`,
  "/bbb/360p/vod.m3u8": `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="init_0.mp4"
#EXTINF:4.000000,
seg_0000.m4s
#EXTINF:4.000000,
seg_0001.m4s
#EXT-X-ENDLIST
`,
};

const env = {
  ASSETS: {
    fetch: (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : input)
        .pathname;
      const body = FILES[path];
      return Promise.resolve(
        body === undefined
          ? new Response("Not found", { status: 404 })
          : new Response(body),
      );
    },
  },
} as unknown as Env;

function get(path: string, method = "GET") {
  return worker.fetch(
    new Request(`https://live.example.workers.dev${path}`, { method }),
    env,
  );
}

describe("worker", () => {
  it("serves the live multivariant playlist", async () => {
    const response = await get("/bbb/live.m3u8");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/vnd.apple.mpegurl",
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.text()).toContain("\n360p/live.m3u8\n");
  });

  it("serves a live media playlist", async () => {
    const response = await get("/bbb/360p/live.m3u8");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("#EXT-X-MEDIA-SEQUENCE:");
    expect(text).toMatch(/\nseg_000[01]\.m4s\?loop=\d+\n/);
    expect(text).not.toContain("#EXT-X-ENDLIST");
  });

  it("makes the window as long as WINDOW_MS", async () => {
    const text = await (await get("/bbb/360p/live.m3u8")).text();
    const segments = text.split("\n").filter((l) => l.startsWith("seg_"));
    // 4 s segments in the test playlist.
    expect(segments).toHaveLength(Math.ceil(WINDOW_MS / 4000));
  });

  it("answers HEAD without a body", async () => {
    const response = await get("/bbb/360p/live.m3u8", "HEAD");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("returns 404 for an unknown stream or path", async () => {
    expect((await get("/nope/live.m3u8")).status).toBe(404);
    expect((await get("/bbb/360p/other.m3u8")).status).toBe(404);
    expect((await get("/")).status).toBe(404);
  });

  it("returns 405 for other methods", async () => {
    expect((await get("/bbb/live.m3u8", "POST")).status).toBe(405);
  });
});
