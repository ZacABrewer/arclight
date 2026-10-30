# Hardware transcoding

[Transcode rules](media-management.md#transcode-rules-optional) can re-encode video on a GPU instead of the CPU. A GPU encode is many times faster and leaves the CPU free, but it only works when the container can reach the GPU. This page explains what each backend needs, how to pass the GPU into the container, and how to check that it works.

Hardware encoding is optional. Rules set to **None (software)** encode on the CPU and need nothing extra.

## The backends

A rule's **Hardware encoding** option picks one backend:

| Backend | Hardware | What the container needs |
|---|---|---|
| None (software) | Any CPU | Nothing |
| VAAPI | Intel iGPU or Arc, AMD Radeon | `/dev/dri` passed through, and a VA driver for the GPU |
| Intel Quick Sync (QSV) | Intel iGPU or Arc | `/dev/dri` passed through. QSV runs on top of VA-API, so it needs the same device |
| NVIDIA NVENC | NVIDIA GeForce, Quadro or Tesla | The NVIDIA driver on the host and the NVIDIA Container Toolkit |
| VideoToolbox | Apple Silicon or Intel Mac | Only for a native (non-Docker) install on macOS. Docker on a Mac cannot reach the GPU |

The Arclight image ships Jellyfin's ffmpeg build, which includes VA-API, Quick Sync and NVENC support. On amd64 it also bundles the Intel media driver (iHD) and the Intel GPU runtimes for Quick Sync (oneVPL for recent GPUs, the older Media SDK runtime for older ones), so nothing needs to be installed inside the container. The arm64 image has NVENC support only: VA-API and Quick Sync are not available there.

Every ffmpeg build lists the backends it was compiled with (`ffmpeg -hwaccels`), whether or not the GPU is reachable. Arclight does not trust that list. It tests each backend with a real encode, see [Checking that it works](#checking-that-it-works).

## Intel and AMD: pass `/dev/dri` through

### 1. Check the device on the host

On the host (over SSH), run:

```sh
ls -l /dev/dri
```

A working iGPU shows a `renderD128` node, usually with a `card0` or `card1` next to it:

```text
crw-rw---- 1 root video  226,   0 card0
crw-rw---- 1 root render 226, 128 renderD128
```

If `/dev/dri` does not exist, the host has no GPU driver loaded and no container can use the GPU. Common causes:

- The CPU has no integrated GPU. Many NAS models use CPUs without one (some AMD Ryzen embedded and Intel Atom/Celeron models, and most ARM NAS). Check the CPU model on the manufacturer's site.
- The iGPU is turned off in the BIOS or UEFI, often because a discrete GPU or no monitor is detected. Look for an option such as "iGPU", "Integrated graphics" or "Multi-monitor" and enable it.
- The kernel driver is not loaded. On most Linux distributions this is `i915` (or `xe` for newer Intel GPUs) and `amdgpu` for AMD. Some NAS operating systems need a plugin, a community driver package, or a newer OS version to load it. Check your NAS vendor's or community's notes for your model.

### 2. Add the device to the compose file

Every compose file in `docker/` has this block commented out under the `arclight` service. Uncomment the two `devices` lines:

```yaml
  arclight:
    # ...
    devices:
      - /dev/dri:/dev/dri
```

In the VPN layouts the `arclight` service shares Gluetun's network (`network_mode: "service:gluetun"`). The `devices` lines still go on the `arclight` service, not on `gluetun`.

On a NAS GUI (Container Manager, Container Station, a TrueNAS custom app, an Unraid template), look for a "Devices" or "Device passthrough" field and add `/dev/dri`.

Recreate the container so the change applies:

```sh
docker compose -f docker-compose.release.yml up -d
```

### 3. Group access is handled for you

`/dev/dri/renderD128` is owned by a group on the host (usually `render` or `video`), and the user Arclight runs as (your `PUID`/`PGID`) is normally not in it. You do not need to change `PUID`, `PGID` or the device permissions: on every start the container looks at each device under `/dev/dri` (and `/dev/nvidia*`), adds the app user to the group that owns it, creating a group with that number if needed, and then starts Arclight. The container log shows one line per group added, for example:

```text
/dev/dri/renderD128 found: arclight added to group render (105)
```

If that line is missing, the device was not passed through. Check step 2.

## NVIDIA: the NVIDIA Container Toolkit

NVENC needs two things on the host:

1. The NVIDIA driver, so `nvidia-smi` works on the host.
2. The NVIDIA Container Toolkit, so Docker can hand the GPU to a container. Install it with your distribution's or NAS vendor's instructions (some NAS systems offer it as a plugin or app).

Then uncomment the NVIDIA block under the `arclight` service instead of the `/dev/dri` lines:

```yaml
  arclight:
    # ...
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu, video]
```

The `video` capability is the one that exposes the encoder. Without it the GPU is visible but NVENC fails. With `docker run` or a NAS GUI, use the NVIDIA Container Toolkit's documented way to request the GPU with the `video` capability.

Docker Desktop on Windows with the WSL2 backend can pass an NVIDIA GPU through when the Windows NVIDIA driver supports it. Intel and AMD GPUs cannot be passed through on Docker Desktop.

## Checking that it works

Open **Settings > Transcode**. Below the rules, the **Hardware acceleration** pane lists every backend with the result of a test: a one-frame encode of a test picture, run with exactly the same device and encoder flags a real job uses. The results are kept until Arclight restarts.

| Status | Meaning |
|---|---|
| Works | The test encode finished. Rules can use this backend |
| Unavailable | The test failed. The **Reason** column shows ffmpeg's own error line |

Press **Test again** after changing the compose file or the host, to run the tests again without restarting.

Common reasons and what they mean:

| Reason (from ffmpeg) | Likely cause |
|---|---|
| `No VA display found for device /dev/dri/renderD128` | `/dev/dri` is not passed through, or the app user cannot open it |
| `Failed to set value '/dev/dri/renderD128' for option 'vaapi_device'` | The same: no usable render device in the container |
| `Failed to set value 'qsv=hw' for option 'init_hw_device'` | Quick Sync could not open the GPU. Usually no `/dev/dri`, an AMD GPU (QSV is Intel-only), or a CPU without Quick Sync |
| `No supported child device type is enabled` | The ffmpeg in use was built without VA-API, so Quick Sync can never work. This happens with a custom `ARCLIGHT_FFMPEG` pointing at a static ffmpeg build; use the bundled one |
| `Error creating a MFX session` | The GPU is too old for the oneVPL runtime, or the iGPU is disabled |
| `Cannot load libcuda.so.1` | The NVIDIA Container Toolkit is missing or the `deploy` block is not active |
| `No NVENC capable devices found` | The GPU has no encoder, or the `video` capability is missing |
| `this ffmpeg build has no ... support` | The backend is not in this build at all (for example VideoToolbox on Linux, or VA-API on arm64). Nothing to fix |

Backends that fail their test are disabled in the rule editor's **Hardware encoding** list. A rule that already uses one keeps it, and the editor and the Hardware acceleration pane show a warning naming the rule and the reason.

## Software fallback

The **Fall back to software** switch in the Hardware acceleration pane is on by default. When a job's hardware backend cannot start (ffmpeg reports that the device, driver or session could not be created), Arclight retries that job once on the CPU with the same settings. Presets that only exist on the GPU encoders (such as NVENC's `p5`) are dropped for the retry. The job's message under **Activity > Transcode jobs**, and the history entry, say which backend was unavailable, why, and that software was used.

Turn it off to make such jobs fail instead. The failure message names the backend, ffmpeg's reason and the usual fix (pass `/dev/dri` or the NVIDIA runtime, check the device group, test again). Jobs that fail for other reasons (a damaged source file, a full disk) are never retried.

Software encoding of large files is slow on low-power NAS CPUs. If you rely on the fallback, a [time window](media-management.md#transcode-rules-optional) on the rule keeps the work to quiet hours.

## Related

- [media-management.md](media-management.md#transcode-rules-optional): transcode rules
- [activity.md](activity.md#transcode-jobs): the job list
- [../getting-started/install-docker.md](../getting-started/install-docker.md): the compose files
- [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)
