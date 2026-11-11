/**
 * Turns a VOD HLS media playlist into a looping live playlist.
 *
 * The live position comes from the clock only: every request, on any
 * server, at the same time, gets the same playlist. Absolute segment k
 * is VOD segment `k % count` in loop `floor(k / count)`, and it is
 * available when its end time is in the past.
 */

export interface VodSegment {
  uri: string;
  durationMs: number;
  /** Start time in the loop. */
  startMs: number;
}

export interface VodMediaPlaylist {
  version: number;
  targetDuration: number;
  independentSegments: boolean;
  /** Attributes of EXT-X-MAP, for example `URI="init.mp4"`. */
  mapAttributes?: string;
  segments: VodSegment[];
  loopDurationMs: number;
}

export interface LiveOptions {
  /** Time when loop 0 starts. */
  epochMs: number;
  /** Number of segments in the live playlist. */
  windowSize: number;
}

export function isMultivariantPlaylist(text: string): boolean {
  return text.includes("#EXT-X-STREAM-INF:");
}

export function parseVodMediaPlaylist(text: string): VodMediaPlaylist {
  let version = 1;
  let targetDuration = 0;
  let independentSegments = false;
  let mapAttributes: string | undefined;
  let pendingDurationMs: number | undefined;
  const segments: VodSegment[] = [];
  let startMs = 0;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;

    if (line.startsWith("#EXT-X-VERSION:")) {
      version = Number(line.slice("#EXT-X-VERSION:".length));
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.slice("#EXT-X-TARGETDURATION:".length));
    } else if (line === "#EXT-X-INDEPENDENT-SEGMENTS") {
      independentSegments = true;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      mapAttributes = line.slice("#EXT-X-MAP:".length);
    } else if (line.startsWith("#EXTINF:")) {
      const value = line.slice("#EXTINF:".length).split(",")[0];
      pendingDurationMs = Math.round(Number(value) * 1000);
    } else if (!line.startsWith("#")) {
      if (pendingDurationMs === undefined) {
        throw new Error(`Segment URI without EXTINF: ${line}`);
      }
      segments.push({ uri: line, durationMs: pendingDurationMs, startMs });
      startMs += pendingDurationMs;
      pendingDurationMs = undefined;
    }
  }

  if (segments.length === 0) throw new Error("Playlist has no segments");

  return {
    version,
    targetDuration,
    independentSegments,
    mapAttributes,
    segments,
    loopDurationMs: startMs,
  };
}

export function buildLiveMediaPlaylist(
  vod: VodMediaPlaylist,
  nowMs: number,
  { epochMs, windowSize }: LiveOptions,
): string {
  const { segments, loopDurationMs } = vod;
  const count = segments.length;

  const elapsedMs = Math.max(0, nowMs - epochMs);
  const loop = Math.floor(elapsedMs / loopDurationMs);
  const offsetMs = elapsedMs - loop * loopDurationMs;

  // Segments of the current loop that have ended.
  let ended = 0;
  while (
    ended < count &&
    segments[ended].startMs + segments[ended].durationMs <= offsetMs
  ) {
    ended++;
  }

  // Before the first segment ends, show it anyway: a live playlist
  // must not be empty.
  const last = Math.max(0, loop * count + ended - 1);
  const first = Math.max(0, last - windowSize + 1);

  const lines = [
    "#EXTM3U",
    `#EXT-X-VERSION:${vod.version}`,
    `#EXT-X-TARGETDURATION:${vod.targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    // Discontinuity sequence number of the first segment: the number of
    // loop starts before it.
    `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first / count)}`,
  ];
  if (vod.independentSegments) lines.push("#EXT-X-INDEPENDENT-SEGMENTS");
  if (vod.mapAttributes) lines.push(`#EXT-X-MAP:${vod.mapAttributes}`);

  for (let k = first; k <= last; k++) {
    const index = k % count;
    const segmentLoop = Math.floor(k / count);
    const segment = segments[index];

    if (index === 0 && k !== first) lines.push("#EXT-X-DISCONTINUITY");

    const startMs = epochMs + segmentLoop * loopDurationMs + segment.startMs;
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(startMs).toISOString()}`);
    lines.push(`#EXTINF:${(segment.durationMs / 1000).toFixed(3)},`);
    // A real live stream never repeats a segment URL. The loop number
    // keeps URLs unique, so a player or a P2P loader that identifies
    // segments by URL sees each loop as new segments.
    lines.push(withQuery(segment.uri, `loop=${segmentLoop}`));
  }

  return lines.join("\n") + "\n";
}

/** Points variant and rendition URIs from `vod.m3u8` to `live.m3u8`. */
export function buildLiveMultivariantPlaylist(vodText: string): string {
  return vodText.replace(/(?<=^|[/"])vod\.m3u8(?=$|")/gm, "live.m3u8");
}

function withQuery(uri: string, query: string): string {
  return uri + (uri.includes("?") ? "&" : "?") + query;
}
