import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import tokens from '../../../../../design/arclight-kit/handoff/tokens.json';
import { Chip, StatusChip } from './Chip.js';
import { ProtocolBadge, ScoreTag, formatScore } from './Tag.js';
import { STATUS_LABELS, STATUS_STYLES, resolveStatus, statusLabel, type StatusKey } from '../tokens.js';

const VOCAB: Array<[string, string]> = [
  ['Downloaded', 'downloaded'],
  ['Downloading', 'downloading'],
  ['Importing', 'importing'],
  ['Monitored', 'monitored'],
  ['Unmonitored', 'unmonitored'],
  ['Unaired', 'unaired'],
  ['Queued', 'queued'],
  ['Paused', 'paused'],
  ['Waiting for air date', 'queued'],
  ['Missing', 'missing'],
  ['Cutoff unmet', 'cutoff'],
  ['Stalled', 'stalled'],
  ['Failed', 'failed'],
];

describe('StatusChip vocabulary', () => {
  it.each(VOCAB)('"%s" renders that exact label with data-status="%s"', (label, attr) => {
    const props = label === 'Failed' || label === 'Stalled' ? { status: label, cause: 'x' } : { status: label };
    render(<StatusChip {...(props as { status: string })} />);
    const chip = screen.getByText((t) => t.startsWith(label));
    expect(chip.className).toContain('al-chip');
    expect(chip.getAttribute('data-status')).toBe(attr);
  });

  it('covers exactly the 13 labels of the handoff README', () => {
    expect(Object.values(STATUS_LABELS)).toEqual(VOCAB.map(([l]) => l));
  });

  it('appends the cause for Failed and Stalled', () => {
    render(
      <>
        <StatusChip status="failed" cause="sample only" />
        <StatusChip status="stalled" cause="no peers" />
      </>,
    );
    expect(screen.getByText('Failed · sample only')).toBeTruthy();
    expect(screen.getByText('Stalled · no peers')).toBeTruthy();
  });

  it('resolves keys, labels and labels with causes', () => {
    expect(resolveStatus('cutoffUnmet')).toBe('cutoffUnmet');
    expect(resolveStatus('Cutoff unmet')).toBe('cutoffUnmet');
    expect(resolveStatus('failed · sample only')).toBe('failed');
    expect(resolveStatus('WAITING FOR AIR DATE')).toBe('waiting');
    expect(resolveStatus('Health 88')).toBeUndefined();
    expect(statusLabel('stalled', 'no peers')).toBe('Stalled · no peers');
  });

  it('matches every status style in tokens.json (border, text, dot, fill, live)', () => {
    const dotOf = (d: string) => (d === 'ring' || d === 'ring-warn' ? d : 'fill');
    for (const [key, spec] of Object.entries(tokens.status) as Array<[StatusKey, Record<string, unknown>]>) {
      const ours = STATUS_STYLES[key];
      expect(ours, key).toBeDefined();
      expect(ours.border).toBe(spec.border);
      expect(ours.text).toBe(spec.text);
      expect(ours.dot).toBe(dotOf(String(spec.dot)));
      expect(ours.fill).toBe((spec.fill as string | undefined) ?? null);
      expect(ours.live).toBe(spec.live === true);
    }
  });

  it('marks live states (downloading, importing) without adding glow classes', () => {
    render(<StatusChip status="downloading" />);
    const chip = screen.getByText('Downloading');
    expect(chip.getAttribute('data-live')).toBe('true');
    expect(chip.className).not.toMatch(/glow|live/);
  });

  it('records ring dots for Unaired, Unmonitored and Cutoff unmet', () => {
    render(
      <>
        <StatusChip status="unaired" />
        <StatusChip status="unmonitored" />
        <StatusChip status="cutoffUnmet" />
        <StatusChip status="missing" />
      </>,
    );
    expect(screen.getByText('Unaired').getAttribute('data-dot')).toBe('ring');
    expect(screen.getByText('Unmonitored').getAttribute('data-dot')).toBe('ring');
    expect(screen.getByText('Cutoff unmet').getAttribute('data-dot')).toBe('ring-warn');
    expect(screen.getByText('Missing').getAttribute('data-dot')).toBe('fill');
  });

  it('can force a ring dot onto a filled status', () => {
    render(<StatusChip status="queued" dot="ring" />);
    expect(screen.getByText('Queued').className).toContain('al-chip--ring');
  });

  it('shows unknown statuses as neutral text instead of inventing a colour', () => {
    render(<StatusChip status="Requested" />);
    const chip = screen.getByText('Requested');
    expect(chip.getAttribute('data-status')).toBe('queued');
  });
});

describe('Chip / tags', () => {
  it('maps tones onto existing kit status rules', () => {
    render(
      <>
        <Chip tone="accent">A</Chip>
        <Chip tone="warn">W</Chip>
        <Chip tone="danger">D</Chip>
        <Chip>N</Chip>
      </>,
    );
    expect(screen.getByText('A').getAttribute('data-status')).toBe('monitored');
    expect(screen.getByText('W').getAttribute('data-status')).toBe('missing');
    expect(screen.getByText('D').getAttribute('data-status')).toBe('failed');
    expect(screen.getByText('N').getAttribute('data-status')).toBeNull();
  });

  it('formats custom format scores with tiers and a real minus sign', () => {
    expect(formatScore(150)).toBe('+150');
    expect(formatScore(-10000)).toBe('−10000');
    render(
      <>
        <ScoreTag name="DV" score={150} />
        <ScoreTag name="HDR10" score={50} />
        <ScoreTag name="x265 HD" score={-10000} />
      </>,
    );
    expect(screen.getByText('DV +150').className).toContain('al-score--high');
    expect(screen.getByText('HDR10 +50').className).toBe('al-score');
    expect(screen.getByText('x265 HD −10000').className).toContain('al-score--neg');
  });

  it('renders protocol codes', () => {
    render(
      <>
        <ProtocolBadge protocol="torrent" />
        <ProtocolBadge protocol="usenet" />
      </>,
    );
    expect(screen.getByText('TOR').className).toBe('al-proto');
    expect(screen.getByText('NZB')).toBeTruthy();
  });
});
