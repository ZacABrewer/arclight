import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { QueueItem } from '@arclight/shared';
import { DEFAULT_HISTORY_FILTER, historyQuery, type HistoryFilter } from '../../api/history.js';
import { formatEta } from './activity-shared.js';
import { HistoryFilterBar, toggleEventType } from './history-page.js';
import { RemoveQueueDialog } from './queue-page.js';
import { initialRemoveState, removeReducer, toRemoveOptions } from './queue-remove.js';

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: 1,
  downloadId: 'abc123',
  downloadClientId: 1,
  downloadClientName: 'qBit',
  title: 'Show.S01E01.1080p.WEB-DL',
  status: 'downloading',
  trackedStatus: 'ok',
  statusMessages: [],
  protocol: 'torrent',
  sizeBytes: 1000,
  sizeLeftBytes: 500,
  progress: 0.5,
  added: '2026-10-25T10:00:00.000Z',
  trackedState: 'downloading',
  ...over,
});

describe('queue remove dialog state', () => {
  it('defaults to removing from the client without blocklisting', () => {
    expect(initialRemoveState([item()])).toEqual({ clientAvailable: true, removeFromClient: true, blocklist: false, skipRedownload: false });
  });

  it('cannot remove from a client when nothing has been sent yet', () => {
    const s = initialRemoveState([item({ downloadClientId: null, downloadId: 'pending:7' })]);
    expect(s.clientAvailable).toBe(false);
    expect(s.removeFromClient).toBe(false);
    expect(removeReducer(s, { type: 'removeFromClient', value: true }).removeFromClient).toBe(false);
  });

  it('only allows skipping the redownload while blocklisting, and clears it when blocklist is turned off', () => {
    let s = initialRemoveState([item()]);
    s = removeReducer(s, { type: 'skipRedownload', value: true });
    expect(s.skipRedownload).toBe(false);
    s = removeReducer(s, { type: 'blocklist', value: true });
    s = removeReducer(s, { type: 'skipRedownload', value: true });
    expect(toRemoveOptions(s)).toEqual({ removeFromClient: true, blocklist: true, skipRedownload: true });
    s = removeReducer(s, { type: 'blocklist', value: false });
    expect(toRemoveOptions(s)).toEqual({ removeFromClient: true, blocklist: false, skipRedownload: false });
  });

  it('submits the chosen options from the dialog', () => {
    const onConfirm = vi.fn();
    render(<RemoveQueueDialog items={[item(), item({ id: 2 })]} onClose={() => {}} onConfirm={onConfirm} />);
    expect(screen.getByRole('heading', { name: 'Remove 2 items?' })).toBeTruthy();
    const skip = screen.getByRole('switch', { name: 'Skip redownload' }) as HTMLInputElement;
    expect(skip.disabled).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: 'Add release to blocklist' }));
    expect(skip.disabled).toBe(false);
    fireEvent.click(skip);
    fireEvent.click(screen.getByRole('switch', { name: 'Remove from download client' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onConfirm).toHaveBeenCalledWith({ removeFromClient: false, blocklist: true, skipRedownload: true });
  });
});

describe('history filter', () => {
  it('builds the query string with comma-separated event types', () => {
    expect(historyQuery(DEFAULT_HISTORY_FILTER)).toEqual({ page: 1, pageSize: 25, sortKey: 'date', sortDirection: 'desc' });
    expect(historyQuery({ ...DEFAULT_HISTORY_FILTER, eventTypes: ['grabbed', 'failed'] }).eventType).toBe('grabbed,failed');
  });

  it('toggles an event type and resets to page 1', () => {
    const f: HistoryFilter = { ...DEFAULT_HISTORY_FILTER, page: 4 };
    const on = toggleEventType(f, 'imported');
    expect(on).toMatchObject({ page: 1, eventTypes: ['imported'] });
    expect(toggleEventType(on, 'imported').eventTypes).toEqual([]);
  });

  it('drives the filter from the chip bar', () => {
    const onChange = vi.fn();
    function Harness() {
      const [filter, setFilter] = useState<HistoryFilter>(DEFAULT_HISTORY_FILTER);
      return (
        <HistoryFilterBar
          filter={filter}
          onChange={(f) => {
            setFilter(f);
            onChange(f);
          }}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Grabbed' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ eventTypes: ['failed', 'grabbed'] }));
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ eventTypes: [] }));
  });
});

describe('formatEta', () => {
  it('formats milliseconds as h:mm:ss', () => {
    expect(formatEta(3_725_000)).toBe('1:02:05');
    expect(formatEta(undefined)).toBe('—');
  });
});
