# Live test streams

Looping live HLS streams made from VOD content, for tests of live
playback and of [P2P Media Loader](https://github.com/Novage/p2p-media-loader).
A Cloudflare Worker serves them. No encoder runs: the live position comes
from the clock.

| Stream | Live | VOD |
| --- | --- | --- |
| Big Buck Bunny | `https://live.novage.workers.dev/bbb/live.m3u8` | `https://live.novage.workers.dev/bbb/vod.m3u8` |

## How it works

`scripts/encode.sh` encodes a video into a VOD HLS stream (fMP4, 1080p,
720p and 360p) in `public/<name>/`. All segments in all renditions are 6 s,
with a key frame at each segment boundary, so segment N starts at the same
time in each rendition. P2P works best with equal segments.

The multivariant playlist lists 1080p first. Players such as Safari start
with the first variant. hls.js starts with the highest variant whose
`BANDWIDTH` (peak segment bitrate) is at most 95% of its bandwidth estimate,
often 5 Mbps. So the 1080p peak is kept below 4.75 Mbps: 3 Mbps average
and 3.5 Mbps maximum video bitrate, with a VBV buffer of 1 s. 720p is
1.8/2.1 Mbps and 360p is 0.6/0.7 Mbps.

The files in `public/` deploy as
[static assets](https://developers.cloudflare.com/workers/static-assets/).
A request for a file does not run the Worker, and static asset requests are
free and not limited.

A request for a path that ends in `live.m3u8` runs the Worker
([src/index.ts](src/index.ts)). It reads the `vod.m3u8` in the same folder
and makes the live playlist from it ([src/hls.ts](src/hls.ts)):

- Loop 0 starts at the epoch, 2026-01-01T00:00:00Z. Absolute segment *k* is
  VOD segment *k* mod *count* in loop ⌊*k* / *count*⌋.
- A segment is in the playlist when its end time is in the past. The
  playlist has the last 60 s (10 segments of 6 s). P2P needs a long window: peers
  can share only segments that are still in the playlist.
- `EXT-X-DISCONTINUITY` is before the first segment of each loop, and
  `EXT-X-DISCONTINUITY-SEQUENCE` counts the loop starts before the first
  segment.
- Each segment has `EXT-X-PROGRAM-DATE-TIME`.
- Segment URLs get `?loop=<n>`. A real live stream never repeats a segment
  URL, and players and P2P loaders that identify segments by URL need this.
- The multivariant playlist is the VOD one, with `vod.m3u8` changed to
  `live.m3u8`.

The playlist depends only on the time, so all viewers see the same live
position.

Do not change the epoch: a change moves the live position and the media
sequence of all streams.

## Set up

Requirements: Node.js, ffmpeg.

```sh
npm install
npm test
npm run typecheck
```

## Add or update a stream

Big Buck Bunny (© Blender Foundation, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/),
<https://peach.blender.org/>):

```sh
mkdir -p source
curl -L -o source/bbb.zip https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_30fps_normal.mp4.zip
unzip -d source source/bbb.zip && rm source/bbb.zip
scripts/encode.sh source/bbb_sunflower_1080p_30fps_normal.mp4 bbb
```

The source videos and the encoded files are not in git (`source/` and
`public/*/` are ignored). Keep them on the disk that you deploy from, or
encode them again before a deploy.

Two encodes of the same video are not byte-identical, so after a new encode
the deploy uploads all files again. To change only a playlist, for example
the variant order, edit `public/<name>/vod.m3u8` and do not encode again.

For a quick test, encode only the start of a video:

```sh
MAX_DURATION=30 scripts/encode.sh input.mp4 test
```

The script does these things so that all segments have the same duration
and a loop joins the next one with no buffer gap. Without them, hls.js
stalls at each loop start:

- It encodes without B-frames. With B-frames, the video of each loop starts
  2 frames after the audio.
- It uses only the time where both video and audio exist, cut to whole
  segments. In the Big Buck Bunny source, the video starts 2 frames after
  the audio, and the audio ends 0.4 s before the video. So Big Buck Bunny
  loops after 630 s, not 634.6 s.
- It trims both streams from the same start time in the filter graph and
  resets their timestamps to 0. With `-t` only, ffmpeg adds frames at the
  start of the video and makes an extra short segment.
- It pads the audio with 0.1 s of silence. The live playlist takes the loop
  length from the video, so the audio must not end before the video.

## Run locally

```sh
npm run dev
```

The Worker is at <http://localhost:8787>, for example
<http://localhost:8787/bbb/live.m3u8>.

## Deploy

```sh
npx wrangler login
npm run deploy
```

`wrangler deploy` uploads the Worker and the files in `public/` that changed.
Delete test streams from `public/` before a deploy.

The URL is `https://<worker-name>.<account-subdomain>.workers.dev`. The Worker
name is `name` in [wrangler.jsonc](wrangler.jsonc). Change the account
subdomain in the Cloudflare dashboard: Workers & Pages → Overview → Account
details → Subdomain.

## Limits of the Workers free plan

- 100,000 Worker requests per day. Only playlist requests run the Worker.
  One viewer requests one media playlist each 6 s, about 14,400 requests per
  day, so the free plan is enough for about 165 viewer-hours per day. This
  is why the segments are 6 s and not 4 s.
- 20,000 static asset files per Worker version, 25 MiB per file. Big Buck
  Bunny (10 min 30 s) is about 320 files.
