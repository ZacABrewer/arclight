# Hardware Transcoding

This file covers the Hardware acceleration pane under Settings -> Transcode, the "Fall back to software" setting and the container's GPU device access.
Prerequisites: signed in as an admin; at least one transcode rule (Settings -> Transcode) and one library file it matches. Rows that need a GPU say so; on a machine without one, use them to check the failure messages instead. Read [../using/hardware-transcoding.md](../using/hardware-transcoding.md) first.
Test environments: Docker (http://<host>:7878) or NAS for the device rows. Native works for the pane and fallback rows when ffmpeg is on PATH.

## Hardware acceleration pane

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| HWT-01 | Open Settings -> Transcode and find the Hardware acceleration pane below the rules. | Every backend (VAAPI, Quick Sync, NVENC, VideoToolbox) is listed with a status of Works or Unavailable. Unavailable rows show a Reason. | |
| HWT-02 | On a host with no GPU passed in, read the reasons for VAAPI and Quick Sync. | Unavailable, with ffmpeg's own error line (for example "No VA display found"). The text "Function not implemented" for `qsv=hw` does not appear on the current image. | |
| HWT-03 | On a host with an Intel iGPU and `/dev/dri` passed through (amd64), open the pane. | VAAPI and Quick Sync show Works. | |
| HWT-04 | On a host with an NVIDIA GPU, the NVIDIA runtime and the `deploy` block active, open the pane. | NVENC shows Works. Without the `video` capability it shows Unavailable with "No NVENC capable devices found". | |
| HWT-05 | Add or remove the `devices` lines in the compose file, recreate the container, then press **Test again**. | The results are recalculated and change to match, without restarting Arclight. | |
| HWT-06 | Change the compose file and recreate the container, then reload the page without pressing Test again. | Arclight restarted with the container, so the results are fresh. If you change the host while Arclight keeps running, the old results stay until you press Test again. | |
| HWT-07 | Open a rule's editor and look at the Hardware encoding list. | Backends that are Unavailable are disabled. A rule that already uses one keeps it, and the editor and the pane show a warning naming the rule and the reason. | |
| HWT-08 | Open the pane on the arm64 image (for example a Raspberry Pi). | VAAPI and Quick Sync are Unavailable (not in the build). NVENC is the only backend that can work. | |

## Fall back to software

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| HWT-09 | Check the "Fall back to software" switch on a fresh install. | It is on. | |
| HWT-10 | With a backend Unavailable, set a rule to use it and run the rule on one file. | The job finishes. Its message under Activity -> Transcode jobs, and the history entry, say which backend was unavailable, why, and that software was used. | |
| HWT-11 | Turn the switch off and run the same rule again. | The job fails with a message naming the backend, ffmpeg's reason and the usual fix. | |
| HWT-12 | Run a rule on a damaged or truncated file with the switch on. | The job fails and is not retried in software. | |

## Container device access

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| HWT-13 | With `/dev/dri` passed through, run `docker logs arclight` right after a start. | One line per device, for example "/dev/dri/renderD128 found: arclight added to group render (105)". | |
| HWT-14 | Without the `devices` lines, restart and read the log. | No such line, and the container still starts normally. | |
| HWT-15 | After HWT-13, run `docker exec arclight id` with `PUID` and `PGID` unchanged. | The app user lists the device's group. `PUID` and `PGID` did not need changing. | |
