import { describe, expect, it } from "vitest";
import {
  buildLiveMediaPlaylist,
  buildLiveMultivariantPlaylist,
  isMultivariantPlaylist,
  parseVodMediaPlaylist,
} from "../src/hls";

// 3 segments: 4 s + 4 s + 2 s = a 10 s loop.
const VOD = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init_1.mp4"
#EXTINF:4.000000,
seg_0000.m4s
#EXTINF:4.000000,
seg_0001.m4s
#EXTINF:2.000000,
seg_0002.m4s
#EXT-X-ENDLIST
`;

const MULTIVARIANT = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=915922,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"
360p/vod.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=2954212,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
720p/vod.m3u8
`;

const EPOCH = Date.UTC(2026, 0, 1);
const options = { epochMs: EPOCH, windowSize: 4 };
const vod = parseVodMediaPlaylist(VOD);

function live(atMs: number) {
  return buildLiveMediaPlaylist(vod, EPOCH + atMs, options);
}

function tag(playlist: string, name: string) {
  const line = playlist.split("\n").find((l) => l.startsWith(`#${name}:`));
  return line?.slice(name.length + 2);
}

function uris(playlist: string) {
  return playlist.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
}

describe("parseVodMediaPlaylist", () => {
  it("reads segments, start times and the loop duration", () => {
    expect(vod.segments).toEqual([
      { uri: "seg_0000.m4s", durationMs: 4000, startMs: 0 },
      { uri: "seg_0001.m4s", durationMs: 4000, startMs: 4000 },
      { uri: "seg_0002.m4s", durationMs: 2000, startMs: 8000 },
    ]);
    expect(vod.loopDurationMs).toBe(10_000);
    expect(vod.targetDuration).toBe(4);
    expect(vod.version).toBe(7);
    expect(vod.independentSegments).toBe(true);
    expect(vod.mapAttributes).toBe('URI="init_1.mp4"');
  });

  it("rejects a playlist without segments", () => {
    expect(() => parseVodMediaPlaylist("#EXTM3U\n#EXT-X-ENDLIST\n")).toThrow();
  });
});

describe("buildLiveMediaPlaylist", () => {
  it("shows the first segment before it ends", () => {
    const playlist = live(1000);
    expect(tag(playlist, "EXT-X-MEDIA-SEQUENCE")).toBe("0");
    expect(uris(playlist)).toEqual(["seg_0000.m4s?loop=0"]);
  });

  it("adds a segment only when it has ended", () => {
    expect(uris(live(3999))).toEqual(["seg_0000.m4s?loop=0"]);
    expect(uris(live(4000))).toEqual(["seg_0000.m4s?loop=0"]);
    expect(uris(live(7999))).toEqual(["seg_0000.m4s?loop=0"]);
    expect(uris(live(8000))).toEqual([
      "seg_0000.m4s?loop=0",
      "seg_0001.m4s?loop=0",
    ]);
  });

  it("puts a discontinuity before each new loop and makes URLs unique", () => {
    // Ended at 25 s: absolute segments 0..6 (loop 2 has ended seg 0).
    const playlist = live(25_000);
    expect(tag(playlist, "EXT-X-MEDIA-SEQUENCE")).toBe("3");
    expect(tag(playlist, "EXT-X-DISCONTINUITY-SEQUENCE")).toBe("1");
    expect(playlist).toContain(
      [
        "#EXTINF:2.000,",
        "seg_0002.m4s?loop=1",
        "#EXT-X-DISCONTINUITY",
        "#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:20.000Z",
        "#EXTINF:4.000,",
        "seg_0000.m4s?loop=2",
      ].join("\n"),
    );
    expect(uris(playlist)).toEqual([
      "seg_0000.m4s?loop=1",
      "seg_0001.m4s?loop=1",
      "seg_0002.m4s?loop=1",
      "seg_0000.m4s?loop=2",
    ]);
  });

  it("does not put a discontinuity before the first segment", () => {
    // Ended at 34 s: absolute segments 0..9, window 6..9 starts at loop 2.
    const playlist = live(34_000);
    expect(tag(playlist, "EXT-X-MEDIA-SEQUENCE")).toBe("6");
    expect(tag(playlist, "EXT-X-DISCONTINUITY-SEQUENCE")).toBe("2");
    expect(playlist.split("#EXT-X-DISCONTINUITY\n")).toHaveLength(2);
    expect(uris(playlist)).toEqual([
      "seg_0000.m4s?loop=2",
      "seg_0001.m4s?loop=2",
      "seg_0002.m4s?loop=2",
      "seg_0000.m4s?loop=3",
    ]);
  });

  it("keeps the discontinuity sequence of a segment the same over time", () => {
    // Absolute segment 9 (loop 3, seg 0) has discontinuity sequence 3,
    // both after a discontinuity tag and as the first segment.
    const middle = live(43_000); // window 8..11
    expect(tag(middle, "EXT-X-MEDIA-SEQUENCE")).toBe("8");
    expect(tag(middle, "EXT-X-DISCONTINUITY-SEQUENCE")).toBe("2");
    expect(middle).toContain("#EXT-X-DISCONTINUITY\n");
    expect(uris(middle)[1]).toBe("seg_0000.m4s?loop=3");

    const later = live(44_000); // window 9..12
    expect(tag(later, "EXT-X-MEDIA-SEQUENCE")).toBe("9");
    expect(tag(later, "EXT-X-DISCONTINUITY-SEQUENCE")).toBe("3");
    expect(uris(later)[0]).toBe("seg_0000.m4s?loop=3");
  });

  it("writes the header tags", () => {
    const playlist = live(25_000);
    expect(playlist.startsWith("#EXTM3U\n#EXT-X-VERSION:7\n")).toBe(true);
    expect(tag(playlist, "EXT-X-TARGETDURATION")).toBe("4");
    expect(tag(playlist, "EXT-X-MAP")).toBe('URI="init_1.mp4"');
    expect(playlist).toContain("#EXT-X-INDEPENDENT-SEGMENTS\n");
    expect(playlist).not.toContain("#EXT-X-ENDLIST");
    expect(playlist).not.toContain("#EXT-X-PLAYLIST-TYPE");
  });

  it("gives every segment a program date time from the epoch", () => {
    const playlist = live(1_000_000);
    const dates = playlist
      .split("\n")
      .filter((l) => l.startsWith("#EXT-X-PROGRAM-DATE-TIME:"));
    expect(dates).toHaveLength(4);
    expect(dates.at(-1)).toBe(
      // Last ended segment: loop 99, seg 2, start 99 * 10 s + 8 s = 998 s.
      "#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:16:38.000Z",
    );
  });
});

describe("buildLiveMultivariantPlaylist", () => {
  it("points the variants to live playlists", () => {
    expect(isMultivariantPlaylist(MULTIVARIANT)).toBe(true);
    expect(isMultivariantPlaylist(VOD)).toBe(false);
    const playlist = buildLiveMultivariantPlaylist(MULTIVARIANT);
    expect(uris(playlist)).toEqual(["360p/live.m3u8", "720p/live.m3u8"]);
    expect(playlist).not.toContain("vod.m3u8");
  });

  it("rewrites URI attributes of renditions", () => {
    const text = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/vod.m3u8"\n';
    expect(buildLiveMultivariantPlaylist(text)).toBe(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/live.m3u8"\n',
    );
  });
});
