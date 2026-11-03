#!/usr/bin/env node
// Lints the compose files we ship (docker/*compose*.yml, attached to every release):
//   1. no image may float: an explicit tag is required and `latest` is rejected (commented
//      alternatives such as the GPU whisper image count too, since users uncomment them);
//   2. every published port names a host IP (`127.0.0.1:7879:7879`, including the default of a
//      `${VAR:-ip:port}` substitution), unless its line carries the marker
//      `publish: all-interfaces` with a reason, for ports meant for the LAN or for peers.
//
//   node scripts/check-compose.mjs [file ...]     default: every docker/*compose*.y{a,}ml
//
// No YAML parser (no dependencies): the files are plain block YAML and the checks only need
// `image:` lines and `ports:` lists, so a line scanner is enough.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** First-party image whose `latest` tag is the release channel (ARCLIGHT_IMAGE pins a version). */
export const LATEST_ALLOWED = new Set(['ghcr.io/zacabrewer/arclight:latest']);

const ALL_INTERFACES_MARKER = /publish:\s*all-interfaces/;

/** Replace `${VAR:-default}` / `${VAR-default}` with the default; null when a variable has none. */
export function expandDefaults(value) {
  let unresolved = false;
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}/g, (_m, _name, op, arg) => {
    if (op === ':-' || op === '-') return arg;
    unresolved = true;
    return '';
  });
  return unresolved ? null : out;
}

/** Split a trailing `# comment` off a YAML line (ignoring `#` inside quotes). */
function splitComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return { code: line.slice(0, i), comment: line.slice(i + 1) };
    }
  }
  return { code: line, comment: '' };
}

function unquote(s) {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
}

/**
 * Does a short-syntax port (`[HOST_IP:][HOST_PORT:]CONTAINER_PORT[/proto]`) name a host IP?
 * Returns 'ok', 'no-ip' or 'unresolved' (a variable without a default).
 */
export function portHostIp(raw) {
  const value = expandDefaults(unquote(raw));
  if (value === null) return 'unresolved';
  let rest = value.replace(/\/(tcp|udp|sctp)$/i, '');
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    return end > 1 && rest[end + 1] === ':' ? 'ok' : 'no-ip';
  }
  return rest.split(':').length >= 3 ? 'ok' : 'no-ip';
}

/** Is an image reference pinned (explicit tag that is not `latest`, or a digest)? */
export function imageProblem(raw) {
  const value = expandDefaults(unquote(raw));
  if (value === null || value === '') return null; // fully variable: nothing to judge
  if (value.includes('@sha256:')) return null;
  const lastSlash = value.lastIndexOf('/');
  const colon = value.lastIndexOf(':');
  if (colon <= lastSlash) return 'has no tag (implicitly latest)';
  const tag = value.slice(colon + 1);
  if (/^latest(\b|-)/.test(tag) && !LATEST_ALLOWED.has(value)) return `uses the floating "${tag}" tag`;
  return null;
}

/** Lint one compose file's text. Returns `line: message` strings. */
export function lintCompose(text) {
  const problems = [];
  const lines = text.split(/\r?\n/);
  let portsIndent = -1;
  let longItem = null; // { line, indent, published, hostIp, marker }
  const closeLong = () => {
    if (longItem && longItem.published && !longItem.hostIp && !longItem.marker) {
      problems.push(`${longItem.line}: published port has no host_ip`);
    }
    longItem = null;
  };

  lines.forEach((line, i) => {
    const n = i + 1;
    const { code, comment } = splitComment(line);
    const indent = line.length - line.trimStart().length;

    // Images, also in commented-out alternatives users are told to uncomment.
    const img = /^\s*#?\s*-?\s*image:\s*(\S+)/.exec(line);
    if (img) {
      const problem = imageProblem(splitComment(img[1]).code);
      if (problem) problems.push(`${n}: image ${img[1]} ${problem}`);
    }

    if (code.trim() === '') return; // blank or comment-only: ports lists may contain these
    if (portsIndent >= 0 && indent <= portsIndent) {
      closeLong();
      portsIndent = -1;
    }
    if (/^\s*ports:\s*$/.test(code)) {
      portsIndent = indent;
      return;
    }
    if (portsIndent < 0) return;

    const marker = ALL_INTERFACES_MARKER.test(comment);
    const item = /^\s*-\s*(.*)$/.exec(code);
    if (item) {
      closeLong();
      const body = item[1].trim();
      const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(body);
      if (kv && !/^["']/.test(body)) {
        longItem = { line: n, indent, published: false, hostIp: false, marker };
        if (kv[1] === 'published') longItem.published = true;
        if (kv[1] === 'host_ip') longItem.hostIp = unquote(kv[2]) !== '';
        return;
      }
      const state = portHostIp(body);
      if (state !== 'ok' && !marker) {
        problems.push(
          state === 'unresolved'
            ? `${n}: port ${body} uses a variable without a default host IP`
            : `${n}: port ${body} is published on all interfaces (add a host IP, or mark it "publish: all-interfaces" with a reason)`,
        );
      }
      return;
    }
    if (longItem) {
      const kv = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(code);
      if (kv?.[1] === 'published') longItem.published = true;
      if (kv?.[1] === 'host_ip') longItem.hostIp = unquote(kv[2]) !== '';
      if (marker) longItem.marker = true;
    }
  });
  closeLong();
  return problems;
}

function main(argv) {
  const files = argv.length
    ? argv
    : readdirSync(join(ROOT, 'docker'))
        .filter((f) => /compose.*\.ya?ml$/.test(f))
        .map((f) => join(ROOT, 'docker', f));
  let failed = 0;
  for (const file of files) {
    const problems = lintCompose(readFileSync(file, 'utf8'));
    for (const p of problems) console.error(`${relative(ROOT, file)}:${p}`);
    failed += problems.length;
  }
  if (failed) {
    console.error(`check-compose: ${failed} problem(s) in ${files.length} file(s)`);
    process.exit(1);
  }
  console.log(`check-compose: ${files.length} compose file(s) OK`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
