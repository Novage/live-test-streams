#!/usr/bin/env bash
# Encodes a video into a VOD HLS stream (fMP4/CMAF) in public/<name>/.
# The Worker serves the same content as a looping live stream.
#
# Usage: scripts/encode.sh <input-video> <name>
#
# Environment:
#   SEGMENT_DURATION  Segment duration in seconds (default 6).
#   MAX_DURATION      Encode only this many seconds of the input (for tests).
#
# Output:
#   public/<name>/vod.m3u8                 multivariant playlist
#   public/<name>/<rendition>/vod.m3u8     media playlist
#   public/<name>/<rendition>/init_N.mp4   init segment
#   public/<name>/<rendition>/seg_NNNN.m4s media segments
#
# All renditions have a key frame at each segment boundary, so segment N
# has the same start time in each rendition.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <input-video> <name>" >&2
  exit 1
fi

input=$1
name=$2
segment_duration=${SEGMENT_DURATION:-6}
out="$(cd "$(dirname "$0")/.." && pwd)/public/$name"

# Start and end time of a stream of the input, for example "v:0" or "a:0".
stream_start() {
  ffprobe -v error -select_streams "$1" \
    -show_entries stream=start_time -of csv=p=0 "$input"
}
stream_end() {
  ffprobe -v error -select_streams "$1" \
    -show_entries stream=start_time,duration -of csv=p=0 "$input" |
    awk -F, '{ printf "%.6f\n", $1 + $2 }'
}

# Each loop must join the next one with no gap in the browser buffer (which
# needs both video and audio), and all segments must have the same
# duration. P2P works best with equal segments. So:
# 1. Use the time where both video and audio exist. In the Big Buck Bunny
#    source, the video starts 2 frames after the audio, and the audio ends
#    0.4 s before the video.
# 2. Cut it to whole segments, also the last segment of the loop.
# 3. Trim both streams in the filter graph from the same start time, and
#    reset their timestamps to 0. With -t only, ffmpeg adds frames at the
#    start of the video and makes an extra short segment.
# 4. Pad the audio with 0.1 s of silence. The audio then ends after the
#    video, and the audio of the next loop overlaps it. The browser removes
#    the overlap.
read -r start available < <(awk \
  -v vs="$(stream_start v:0)" -v as="$(stream_start a:0)" \
  -v ve="$(stream_end v:0)" -v ae="$(stream_end a:0)" \
  'BEGIN {
    s = (vs > as) ? vs : as
    e = (ve < ae) ? ve : ae
    printf "%.6f %.6f\n", s, e - s
  }')
duration=$(awk -v a="$available" -v m="${MAX_DURATION:-0}" \
  -v s="$segment_duration" \
  'BEGIN {
    if (m > 0 && m < a) a = m
    printf "%d\n", int(a / s) * s
  }')
if [[ $duration -le 0 ]]; then
  echo "The input is shorter than one segment" >&2
  exit 1
fi
# Start the trim 1 ms early: start_time is rounded, and the first video
# frame must not be lost.
trim_start=$(awk -v s="$start" 'BEGIN { t = s - 0.001; printf "%.6f\n", (t > 0 ? t : 0) }')
audio_duration=$(awk -v d="$duration" 'BEGIN { printf "%.6f\n", d + 0.1 }')
echo "Encoding $duration s of $input from $start s"

rm -rf "$out"
mkdir -p "$out"

video_filter="trim=start=${trim_start}:duration=${duration},setpts=PTS-STARTPTS"
audio_filter="atrim=start=${trim_start}:duration=${duration},asetpts=PTS-STARTPTS,apad=whole_dur=${audio_duration}"

ffmpeg -hide_banner -y -i "$input" \
  -filter_complex "[0:v:0]${video_filter},split=3[a][b][c];[a]scale=-2:360[v360];[b]scale=-2:720[v720];[c]scale=-2:1080[v1080];[0:a:0]${audio_filter},asplit=3[a360][a720][a1080]" \
  -map "[v360]" -map "[v720]" -map "[v1080]" \
  -map "[a360]" -map "[a720]" -map "[a1080]" \
  -c:v libx264 -profile:v high -preset medium -pix_fmt yuv420p \
  `# No B-frames: with them, video starts 2 frames after audio in each` \
  `# loop, and hls.js gets a buffer gap and a stall at each loop start.` \
  -bf 0 \
  -force_key_frames "expr:gte(t,n_forced*${segment_duration})" -sc_threshold 0 \
  `# hls.js starts with the highest variant whose BANDWIDTH (peak segment` \
  `# bitrate) is at most 95% of its bandwidth estimate. With an estimate of` \
  `# 5 Mbps, that is 4.75 Mbps, so 1080p must peak below it. bufsize equal` \
  `# to maxrate limits a segment of D s to (1 + 1/D) x maxrate. For 1080p` \
  `# with 6 s segments, that is 4.08 Mbps of video plus 128 kbps of audio.` \
  -b:v:0 600k -maxrate:v:0 700k -bufsize:v:0 700k \
  -b:v:1 1800k -maxrate:v:1 2100k -bufsize:v:1 2100k \
  -b:v:2 3000k -maxrate:v:2 3500k -bufsize:v:2 3500k \
  -c:a aac -b:a 128k -ac 2 -ar 48000 \
  -f hls \
  -hls_time "$segment_duration" \
  -hls_playlist_type vod \
  -hls_flags independent_segments \
  -hls_segment_type fmp4 \
  -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename "$out/%v/seg_%04d.m4s" \
  -master_pl_name vod.m3u8 \
  `# The multivariant playlist lists the variants in this order. 1080p is` \
  `# first: players such as Safari start with the first variant.` \
  -var_stream_map "v:2,a:2,name:1080p v:1,a:1,name:720p v:0,a:0,name:360p" \
  "$out/%v/vod.m3u8"

echo
echo "Done: $out"
echo "VOD:  /$name/vod.m3u8"
echo "Live: /$name/live.m3u8"
