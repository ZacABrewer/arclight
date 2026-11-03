#!/bin/sh
# Measures how fast this server's ffmpeg can produce the player's adaptive (HLS) video rungs, on the
# Intel GPU (Quick Sync) and on the CPU. Run it inside the Arclight container, with /dev/dri passed
# through, against your own files:
#
#   docker exec -i arclight sh -s -- /movies/film-4k-hdr.mkv /movies/film-1080p.mkv < scripts/hls-nas-probe.sh
#
# The first file should be a 4K HDR10 HEVC film, the second a 1080p H.264 one (either may be left
# out with "-"). Each variant encodes 120 seconds to nowhere (-f null) and prints the speed: 1.0x is
# real time, and the player needs at least 1.3x for a rung to be offered. Nothing is written to disk.
# See docs/using/hardware-transcoding.md#measuring-the-player-video-speed.
set -u

FFMPEG="${ARCLIGHT_FFMPEG:-ffmpeg}"
DEVICE="${ARCLIGHT_VAAPI_DEVICE:-/dev/dri/renderD128}"
SECONDS_TO_ENCODE="${PROBE_SECONDS:-120}"
HDR="${1:--}"
SDR="${2:--}"

QSV_INIT="-init_hw_device vaapi=va:$DEVICE -init_hw_device qsv=qs@va -filter_hw_device qs"

# run <label> <input> <ffmpeg args...>: prints the label and the last speed ffmpeg reported.
run() {
  label="$1"
  input="$2"
  shift 2
  if [ "$input" = "-" ]; then
    printf '%-44s skipped (no file)\n' "$label"
    return
  fi
  # shellcheck disable=SC2086
  out=$("$FFMPEG" -hide_banner -nostdin -nostats -progress pipe:1 "$@" 2>/dev/null)
  speed=$(printf '%s\n' "$out" | sed -n 's/^speed= *//p' | tail -n 1)
  if [ -z "$speed" ] || [ "$speed" = "N/A" ]; then
    printf '%-44s failed\n' "$label"
  else
    printf '%-44s speed %s\n' "$label" "$speed"
  fi
}

# parallel <n> <label> <input> <args...>: n copies at once, each one's speed.
parallel() {
  n="$1"
  label="$2"
  shift 2
  i=1
  while [ "$i" -le "$n" ]; do
    run "$label (job $i of $n)" "$@" &
    i=$((i + 1))
  done
  wait
}

T="-t $SECONDS_TO_ENCODE"
NULL="-an -f null -"

echo "ffmpeg: $FFMPEG"
"$FFMPEG" -hide_banner -version 2>/dev/null | head -n 1
echo "GPU device: $DEVICE"
[ -e "$DEVICE" ] || echo "warning: $DEVICE is missing in this container; the Quick Sync lines will fail"
echo

# 4K HDR10 HEVC source
# shellcheck disable=SC2086
{
  run "2160 HDR -> 1080 SDR, QSV VPP tone-map" "$HDR" $QSV_INIT -hwaccel qsv -hwaccel_output_format qsv -c:v hevc_qsv $T -i "$HDR" \
    -vf "vpp_qsv=w=1920:h=1080:format=nv12:tonemap=1" -c:v h264_qsv -preset veryfast -look_ahead 0 -low_power 1 -b:v 8M $NULL
  run "2160 HDR -> 1080 SDR, QSV + OpenCL tone-map" "$HDR" $QSV_INIT -hwaccel qsv -hwaccel_output_format qsv -c:v hevc_qsv $T -i "$HDR" \
    -vf "vpp_qsv=w=1920:h=1080:format=p010,hwmap=derive_device=opencl,tonemap_opencl=tonemap=bt2390:desat=0:t=bt709:m=bt709:p=bt709:format=nv12,hwmap=derive_device=qsv:reverse=1,format=qsv" \
    -c:v h264_qsv -preset veryfast -look_ahead 0 -low_power 1 -b:v 8M $NULL
  run "2160 HDR10 kept, HEVC Main 10 (QSV)" "$HDR" $QSV_INIT -hwaccel qsv -hwaccel_output_format qsv -c:v hevc_qsv $T -i "$HDR" \
    -vf "vpp_qsv=w=3840:h=2160:format=p010" -c:v hevc_qsv -preset veryfast -look_ahead 0 -low_power 1 -profile:v main10 -b:v 16M $NULL
  run "2160 -> 2160 SDR HEVC (QSV)" "$HDR" $QSV_INIT -hwaccel qsv -hwaccel_output_format qsv -c:v hevc_qsv $T -i "$HDR" \
    -vf "vpp_qsv=w=3840:h=2160:format=nv12:tonemap=1" -c:v hevc_qsv -preset veryfast -look_ahead 0 -low_power 1 -b:v 16M $NULL
  run "2160 HDR -> 1080 SDR, CPU (x264)" "$HDR" $T -i "$HDR" \
    -vf "scale=1920:1080:flags=fast_bilinear,tonemapx=tonemap=bt2390:t=bt709:m=bt709:p=bt709:format=yuv420p" -c:v libx264 -preset veryfast -b:v 8M $NULL
}

# 1080p H.264 source
# shellcheck disable=SC2086
{
  run "1080 -> 720, QSV" "$SDR" $QSV_INIT -hwaccel qsv -hwaccel_output_format qsv -c:v h264_qsv $T -i "$SDR" \
    -vf "vpp_qsv=w=1280:h=720:format=nv12" -c:v h264_qsv -preset veryfast -look_ahead 0 -low_power 1 -b:v 4M $NULL
  run "1080 -> 720, CPU (x264 veryfast)" "$SDR" $T -i "$SDR" -vf "scale=1280:720:flags=fast_bilinear,format=yuv420p" -c:v libx264 -preset veryfast -b:v 4M $NULL
  run "1080 -> 720, CPU (x264 superfast)" "$SDR" $T -i "$SDR" -vf "scale=1280:720:flags=fast_bilinear,format=yuv420p" -c:v libx264 -preset superfast -b:v 4M $NULL
}

# Several viewers at once: the GPU is shared, so each job gets slower.
# shellcheck disable=SC2086
for n in 2 3; do
  parallel "$n" "2160 HDR -> 1080 SDR, QSV VPP" "$HDR" $QSV_INIT -hwaccel qsv -hwaccel_output_format qsv -c:v hevc_qsv $T -i "$HDR" \
    -vf "vpp_qsv=w=1920:h=1080:format=nv12:tonemap=1" -c:v h264_qsv -preset veryfast -look_ahead 0 -low_power 1 -b:v 8M $NULL
  parallel "$n" "1080 -> 720, QSV" "$SDR" $QSV_INIT -hwaccel qsv -hwaccel_output_format qsv -c:v h264_qsv $T -i "$SDR" \
    -vf "vpp_qsv=w=1280:h=720:format=nv12" -c:v h264_qsv -preset veryfast -look_ahead 0 -low_power 1 -b:v 4M $NULL
done
