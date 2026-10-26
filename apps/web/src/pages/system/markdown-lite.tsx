import type { ReactNode } from 'react';
import { t } from '../../i18n/index.js';

// Release notes are GitHub Markdown. This renders the common subset (headings, bullet and
// numbered lists, paragraphs, `code`, **bold**, [links](url)) as React elements; nothing is
// injected as HTML, so notes from a release feed cannot run script.

type Block = { kind: 'h'; level: number; text: string } | { kind: 'ul' | 'ol'; items: string[] } | { kind: 'p'; text: string } | { kind: 'pre'; text: string };

export function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().startsWith('```')) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith('```'); i++) body.push(lines[i]!);
      blocks.push({ kind: 'pre', text: body.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: 'h', level: h[1]!.length, text: h[2]!.trim() });
    } else if (ul || ol) {
      flush();
      const kind = ul ? 'ul' : 'ol';
      const last = blocks[blocks.length - 1];
      const text = (ul ?? ol)![1]!;
      if (last && last.kind === kind) last.items.push(text);
      else blocks.push({ kind, items: [text] });
    } else if (line.trim() === '') {
      flush();
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

const SAFE_URL = /^(https?:|mailto:|\/)/i;

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code key={key++} className="al-num">{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key++}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) {
      const href = m[5]!;
      out.push(
        SAFE_URL.test(href) ? (
          <a key={key++} className="al-link" href={href} target="_blank" rel="noreferrer">
            {m[4]}
          </a>
        ) : (
          m[4]
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownLite({ source, className }: { source: string; className?: string }) {
  const blocks = parseBlocks(source);
  if (blocks.length === 0) return <p className="al-caption">{t('system.markdownLite.noReleaseNotes')}</p>;
  return (
    <div className={className}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h':
            return (
              <p key={i} className={b.level <= 2 ? 'al-title-s md-h' : 'al-label md-h'}>
                {renderInline(b.text)}
              </p>
            );
          case 'ul':
          case 'ol': {
            const List = b.kind;
            return (
              <List key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </List>
            );
          }
          case 'pre':
            return (
              <pre key={i} className="al-num md-pre">
                {b.text}
              </pre>
            );
          default:
            return <p key={i}>{renderInline(b.text)}</p>;
        }
      })}
    </div>
  );
}
