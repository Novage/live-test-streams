import {
  buildLiveMediaPlaylist,
  buildLiveMultivariantPlaylist,
  isMultivariantPlaylist,
  parseVodMediaPlaylist,
  type LiveOptions,
  type VodMediaPlaylist,
} from "./hls";
import { EPOCH_MS, WINDOW_MS } from "./config";

export interface Env {
  ASSETS: Fetcher;
}

function liveOptions(vod: VodMediaPlaylist): LiveOptions {
  const segmentMs = vod.loopDurationMs / vod.segments.length;
  return {
    epochMs: EPOCH_MS,
    windowSize: Math.max(1, Math.ceil(WINDOW_MS / segmentMs)),
  };
}

const LIVE_SUFFIX = "/live.m3u8";

const PLAYLIST_HEADERS = {
  "Content-Type": "application/vnd.apple.mpegurl",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-cache",
};

// Parsed VOD playlists, per isolate. A deploy starts new isolates, so
// new content is read after each deploy.
const vodCache = new Map<string, VodMediaPlaylist>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Static assets (segments, init segments, VOD playlists) do not reach
    // the Worker. Only paths without a file come here.
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (!url.pathname.endsWith(LIVE_SUFFIX)) {
      return new Response("Not found", { status: 404 });
    }

    const vodPath =
      url.pathname.slice(0, -LIVE_SUFFIX.length) + "/vod.m3u8";
    const body = await livePlaylist(env, new URL(vodPath, url), Date.now());
    if (body === undefined) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(request.method === "HEAD" ? null : body, {
      headers: PLAYLIST_HEADERS,
    });
  },
} satisfies ExportedHandler<Env>;

async function livePlaylist(
  env: Env,
  vodUrl: URL,
  nowMs: number,
): Promise<string | undefined> {
  let vod = vodCache.get(vodUrl.pathname);

  if (!vod) {
    const response = await env.ASSETS.fetch(vodUrl);
    if (!response.ok) return undefined;
    const text = await response.text();

    // The multivariant playlist does not depend on the time.
    if (isMultivariantPlaylist(text)) {
      return buildLiveMultivariantPlaylist(text);
    }

    vod = parseVodMediaPlaylist(text);
    vodCache.set(vodUrl.pathname, vod);
  }

  return buildLiveMediaPlaylist(vod, nowMs, liveOptions(vod));
}
