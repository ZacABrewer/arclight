#!/usr/bin/env node
// Renders the Arclight intro (src/stage.ts) to video, frame by frame:
//   arclight-intro-1080p.mp4   1920x1080, 60 fps, H.264 High@4.2, AAC 192k  (Jellyfin Cinema Mode)
//   arclight-intro-720p.mp4    1280x720,  30 fps, H.264 High@3.1, AAC 128k  (small / old devices)
//   arclight-intro-poster.png  the full-logo frame (t = LOGO_TIME)
//   arclight-sting.m4a         the sound as AAC, for the mobile app (arclight-sting.wav is the source)
//
// Time is stepped, never played: each frame is painted with render(i / fps) in headless Chrome and
// screenshotted, so the output is the same on every machine and every run.
//
//   npm ci && npm run render
//
// Browser: an installed Chrome (or Edge), via playwright-core; set CHROME_PATH to use another
// Chromium build. ffmpeg: $FFMPEG, else `ffmpeg` on PATH, else the Arclight Docker image (which
// ships jellyfin-ffmpeg); set FFMPEG_DOCKER_IMAGE to use another image with ffmpeg in it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const FPS = 60;
const DURATION = 6.1;
const LOGO_TIME = 3.9;
const FRAMES_DIR = '.frames';
const DOCKER_IMAGE = process.env.FFMPEG_DOCKER_IMAGE || 'ghcr.io/zacabrewer/arclight:latest';
const args = new Set(process.argv.slice(2));

// ------------------------------------------------------------------ ffmpeg
function resolveTool(name) {
  const env = process.env[name.toUpperCase()];
  if (env) return (a) => spawnSync(env, a, { cwd: here, stdio: 'inherit' });
  if (spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0) return (a) => spawnSync(name, a, { cwd: here, stdio: 'inherit' });
  // Docker: the intro folder is mounted at /work and every path below is relative to it.
  return (a, opts = {}) =>
    spawnSync('docker', ['run', '--rm', '-v', `${here}:/work`, '-w', '/work', '--entrypoint', name, DOCKER_IMAGE, ...a], {
      cwd: here,
      stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      encoding: 'utf8',
    });
}
const ffmpeg = resolveTool('ffmpeg');
const run = (label, a) => {
  console.log(`\n== ${label}`);
  const r = ffmpeg(['-hide_banner', '-loglevel', 'warning', '-y', ...a]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${label}`);
};

// ------------------------------------------------------------------ frames
async function renderFrames() {
  const bundle = await build({
    stdin: {
      contents: `import { createIntroStage } from './src/stage.ts';
        const stage = createIntroStage(document);
        document.body.appendChild(stage.el);
        window.__render = (t) => { stage.render(t); };`,
      resolveDir: here,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    target: 'es2022',
    write: false,
  });
  const js = bundle.outputFiles[0].text;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}</style></head><body><script>${js}</script></body></html>`;

  const launch = async () => {
    if (process.env.CHROME_PATH) return chromium.launch({ executablePath: process.env.CHROME_PATH });
    for (const channel of ['chrome', 'msedge']) {
      try {
        return await chromium.launch({ channel });
      } catch {
        /* try the next one */
      }
    }
    throw new Error('No Chrome or Edge found: install one or set CHROME_PATH');
  };
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.setContent(html);

  rmSync(join(here, FRAMES_DIR), { recursive: true, force: true });
  mkdirSync(join(here, FRAMES_DIR), { recursive: true });
  const total = Math.round(DURATION * FPS);
  const shot = async (t, file) => {
    await page.evaluate((tt) => window.__render(tt), t);
    writeFileSync(file, await page.screenshot({ type: 'png', animations: 'disabled' }));
  };
  for (let i = 0; i < total; i++) {
    await shot(i / FPS, join(here, FRAMES_DIR, `${String(i).padStart(5, '0')}.png`));
    if (i % 60 === 0) process.stdout.write(`frame ${i}/${total}\r`);
  }
  await shot(LOGO_TIME, join(here, 'arclight-intro-poster.png'));
  await browser.close();
  console.log(`${total} frames + poster rendered`);
}

// ------------------------------------------------------------------ encode
// PNG frames are full-range RGB; convert with the BT.709 matrix to limited-range 4:2:0 and tag it.
const colour = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'];
const x264 = (profileLevel, crf, maxrate) => [
  '-c:v', 'libx264', '-preset', 'veryslow', '-tune', 'animation',
  '-profile:v', 'high', '-level:v', profileLevel, '-crf', String(crf),
  '-maxrate', maxrate, '-bufsize', `${parseInt(maxrate, 10) * 2}M`,
  // aq-mode 3 biases bits to dark flat areas: less banding in the glows on black. The colour
  // tags go into the H.264 VUI too, so players that ignore the container tags still get BT.709.
  '-x264-params', 'aq-mode=3:colorprim=bt709:transfer=bt709:colormatrix=bt709',
];

function encode() {
  const input = ['-framerate', String(FPS), '-i', `${FRAMES_DIR}/%05d.png`, '-i', 'arclight-sting.wav', '-map', '0:v:0', '-map', '1:a:0', '-t', String(DURATION)];
  run('1080p60', [
    ...input,
    '-vf', 'scale=1920:1080:out_color_matrix=bt709:out_range=tv,format=yuv420p',
    ...x264('4.2', 16, '12M'), '-g', String(FPS), ...colour,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', 'arclight-intro-1080p.mp4',
  ]);
  run('720p30', [
    ...input,
    '-vf', 'fps=30,scale=1280:720:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p',
    ...x264('3.1', 18, '5M'), '-g', '30', ...colour,
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', 'arclight-intro-720p.mp4',
  ]);
  run('sting.m4a', ['-i', 'arclight-sting.wav', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', 'arclight-sting.m4a']);
}

if (!args.has('--encode-only')) await renderFrames();
encode();
if (!args.has('--keep-frames')) rmSync(join(here, FRAMES_DIR), { recursive: true, force: true });
console.log('\nDone: arclight-intro-1080p.mp4, arclight-intro-720p.mp4, arclight-intro-poster.png, arclight-sting.m4a');
