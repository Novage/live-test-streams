#!/usr/bin/env bash
# Encodes a video into a VOD HLS stream (fMP4/CMAF) in public/<name>/.
# The Worker serves the same content as a looping live stream.
#
# Usage: scripts/encode.sh <input-video> <name>
#
# Environment:
#   SEGMENT_DURATION  Segment duration in seconds (default 4).
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
segment_duration=${SEGMENT_DURATION:-4}
out="$(cd "$(dirname "$0")/.." && pwd)/public/$name"

# End time of a stream of the input, for example "v:0" or "a:0".
stream_end() {
  ffprobe -v error -select_streams "$1" \
    -show_entries stream=start_time,duration -of csv=p=0 "$input" |
    awk -F, '{ printf "%.6f\n", $1 + $2 }'
}

# At each loop start, the browser buffer (which needs both video and audio)
# has a gap and the player stalls if a loop has less audio than video. The
# live playlist takes the loop length from the video, so:
# 1. Cut the input where the shorter of video and audio ends.
# 2. Pad the audio with 0.1 s of silence (more than one video frame). The
#    audio then ends after the video, and the audio of the next loop
#    overlaps it. The browser removes the overlap.
duration=$(printf '%s\n%s\n' "$(stream_end v:0)" "$(stream_end a:0)" |
  sort -n | head -1)
if [[ -n ${MAX_DURATION:-} ]]; then
  duration=$(printf '%s\n%s\n' "$duration" "$MAX_DURATION" | sort -n | head -1)
fi
audio_duration=$(awk -v d="$duration" 'BEGIN { printf "%.6f\n", d + 0.1 }')
echo "Encoding $duration s of $input"

rm -rf "$out"
mkdir -p "$out"

ffmpeg -hide_banner -y -t "$duration" -i "$input" \
  -filter_complex "[0:v]split=3[a][b][c];[a]scale=-2:360[v360];[b]scale=-2:720[v720];[c]scale=-2:1080[v1080]" \
  -map "[v360]" -map "[v720]" -map "[v1080]" \
  -map 0:a:0 -map 0:a:0 -map 0:a:0 \
  -c:v libx264 -profile:v high -preset medium -pix_fmt yuv420p \
  `# No B-frames: with them, video starts 2 frames after audio in each` \
  `# loop, and hls.js gets a buffer gap and a stall at each loop start.` \
  -bf 0 \
  -force_key_frames "expr:gte(t,n_forced*${segment_duration})" -sc_threshold 0 \
  -b:v:0 800k -maxrate:v:0 960k -bufsize:v:0 1600k \
  -b:v:1 2800k -maxrate:v:1 3360k -bufsize:v:1 5600k \
  -b:v:2 5000k -maxrate:v:2 6000k -bufsize:v:2 10000k \
  -af "apad=whole_dur=${audio_duration}" \
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
