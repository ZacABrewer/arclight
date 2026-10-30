import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { CommandPalette, type ResultGroup, type ResultItem } from '../../arclight/index.js';
import { errorMessage } from '../../api/client.js';
import { useToast } from '../../components/toast.js';
import { InteractiveSearchModal } from '../../pages/library/interactive-search.js';
import { t } from '../../i18n/index.js';
import { matchCommands, matchTargets, type PaletteRow } from './matcher.js';
import { pushRecent, readRecent, type RecentAction } from './recent.js';
import { usePaletteContextEntries, type ActionGroup, type ItemKind, type PaletteAction, type PaletteItem, type RunContext } from './registry.js';
import { OPEN_ACTION_ID, usePaletteActions } from './use-palette-actions.js';

// Ctrl/Cmd+K: do things from anywhere by typing. A verb plus a library item ("upg dune"), a
// global command ("approve all"), a scheduled task, a theme or a page. Item verbs without a
// name ask for one; bulk and destructive commands ask before they run.

type Step = { type: 'root' } | { type: 'target'; action: PaletteAction } | { type: 'confirm'; action: PaletteAction; ctx: RunContext };

export function kindLabel(kind: ItemKind): string {
  switch (kind) {
    case 'movie':
      return t('palette.kind.movie');
    case 'series':
      return t('palette.kind.series');
    case 'artist':
      return t('palette.kind.artist');
    case 'author':
      return t('palette.kind.author');
    case 'book':
      return t('palette.kind.book');
  }
}

function groupLabel(group: ActionGroup): string {
  switch (group) {
    case 'navigate':
      return t('layout.searchGroups.navigate');
    case 'task':
      return t('palette.group.tasks');
    case 'theme':
      return t('palette.group.themes');
    default:
      return t('common.actions');
  }
}

const GROUP_ORDER: readonly ActionGroup[] = ['context', 'item', 'global', 'task', 'theme', 'navigate'];

/** "Search for upgrades → Dune (2021)", "Add movie “Dune”". */
export function rowLabel(row: Pick<PaletteRow, 'action' | 'item' | 'text'>): string {
  if (row.item) return t('palette.row.withItem', { action: row.action.label, item: row.item.year ? `${row.item.title} (${row.item.year})` : row.item.title });
  if (row.text) return t('palette.row.withText', { action: row.action.label, text: row.text });
  if (row.action.target?.type === 'item') return t('palette.row.pickItem', { action: row.action.label });
  return row.action.label;
}

export interface CommandPaletteHostProps {
  open: boolean;
  onClose: () => void;
  onShortcuts: () => void;
  /** Text to open with (the topbar search hands an action over). */
  initialQuery?: string | undefined;
}

export function CommandPaletteHost({ open, onClose, onShortcuts, initialQuery = '' }: CommandPaletteHostProps) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [step, setStep] = useState<Step>({ type: 'root' });
  const [recent, setRecent] = useState<RecentAction[]>([]);
  const [interactive, setInteractive] = useState<PaletteItem | null>(null);
  const { actions, items, loading } = usePaletteActions(open, {
    interactiveSearch: (item) => setInteractive(item),
    openShortcuts: onShortcuts,
  });
  const contexts = usePaletteContextEntries();
  const subjects = useMemo(() => contexts.flatMap((c) => (c.subject ? [c.subject] : [])), [contexts]);
  const contextActions = useMemo(() => contexts.flatMap((c) => c.actions ?? []), [contexts]);
  const deferred = useDeferredValue(query);

  useEffect(() => {
    if (open) {
      setRecent(readRecent());
      setQuery(initialQuery);
    } else {
      setQuery('');
      setStep({ type: 'root' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the initial text applies when it opens
  }, [open]);

  const execute = (action: PaletteAction, ctx: RunContext) => {
    setRecent(pushRecent({ actionId: action.id, ...(ctx.item ? { item: ctx.item } : {}), ...(ctx.text ? { text: ctx.text } : {}) }));
    try {
      const out = action.run(ctx);
      if (out instanceof Promise) out.catch((err: unknown) => toast.push({ tone: 'error', title: action.label, message: errorMessage(err) }));
    } catch (err) {
      toast.push({ tone: 'error', title: action.label, message: errorMessage(err) });
    }
  };

  /** Selecting a row: pick a target, confirm, or run. Returns whether the palette stays open. */
  const choose = (action: PaletteAction, ctx: RunContext): boolean => {
    if (action.target?.type === 'item' && !ctx.item) {
      setStep({ type: 'target', action });
      setQuery('');
      return true;
    }
    if (action.destructive) {
      setStep({ type: 'confirm', action, ctx });
      setQuery('');
      return true;
    }
    execute(action, ctx);
    return false;
  };

  const toItem = (row: PaletteRow, idPrefix: string): ResultItem => {
    const staysOpen = (row.action.target?.type === 'item' && !row.item) || row.action.destructive === true;
    return {
      id: `${idPrefix}-${row.action.id}-${row.item ? `${row.item.kind}${row.item.id}` : ''}-${row.text ?? ''}`,
      label: rowLabel(row),
      meta: row.item ? kindLabel(row.item.kind) : row.action.meta,
      hint: row.action.hint,
      keepOpen: staysOpen,
      onSelect: () => void choose(row.action, { item: row.item, text: row.text }),
    };
  };

  const groups = useMemo<ResultGroup[]>(() => {
    if (step.type === 'confirm') {
      const question = step.action.confirm?.(step.ctx) ?? rowLabel({ action: step.action, item: step.ctx.item, text: step.ctx.text });
      return [
        {
          label: t('palette.group.confirm'),
          items: [
            { id: 'confirm', label: question, meta: t('palette.confirm.run'), tone: 'danger', onSelect: () => execute(step.action, step.ctx) },
            { id: 'cancel', label: t('common.cancel'), keepOpen: true, onSelect: () => setStep({ type: 'root' }) },
          ],
        },
      ];
    }
    if (step.type === 'target') {
      const action = step.action;
      const targets = [...subjects.filter((s) => action.target?.type === 'item' && action.target.kinds.includes(s.kind)), ...matchTargets(action, deferred, items)];
      const seen = new Set<string>();
      const rows = targets.filter((i) => {
        const k = `${i.kind}:${i.id}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return [
        {
          label: action.label,
          items: rows.slice(0, 20).map((item) => ({
            id: `target-${item.kind}-${item.id}`,
            label: item.year ? `${item.title} (${item.year})` : item.title,
            meta: kindLabel(item.kind),
            keepOpen: action.destructive === true,
            onSelect: () => void choose(action, { item }),
          })),
        },
      ];
    }

    const q = deferred.trim();
    // "?": every command, grouped.
    if (q === '?') {
      return GROUP_ORDER.filter((g) => g !== 'context' && g !== 'global')
        .map((g) => ({
          label: groupLabel(g),
          items: actions.filter((a) => (a.group === 'global' ? 'item' : a.group) === g).map((a) => toItem({ action: a, score: 0 }, 'help')),
        }))
        .filter((g) => g.items.length > 0);
    }

    if (!q) {
      const out: ResultGroup[] = [];
      // The page's subject first: its item verbs need no name.
      for (const s of subjects) {
        out.push({
          label: t('palette.group.thisPage', { title: s.title }),
          items: actions.filter((a) => a.target?.type === 'item' && a.target.kinds.includes(s.kind) && a.id !== OPEN_ACTION_ID).map((a) => toItem({ action: a, item: s, score: 0 }, 'ctx')),
        });
      }
      if (contextActions.length) out.push({ label: t('palette.group.page'), items: contextActions.map((a) => toItem({ action: a, score: 0 }, 'ctxa')) });
      const recentRows = recent.flatMap((r): PaletteRow[] => {
        const action = actions.find((a) => a.id === r.actionId);
        if (!action) return [];
        if (action.target?.type === 'item' && !r.item) return [];
        return [{ action, item: r.item, text: r.text, score: 0 }];
      });
      out.push({ label: t('palette.group.recent'), items: recentRows.map((r) => toItem(r, 'recent')) });
      out.push({ label: t('palette.group.verbs'), items: actions.filter((a) => a.group === 'item' || a.group === 'global').map((a) => toItem({ action: a, score: 0 }, 'verb')) });
      return out.filter((g) => g.items.length > 0);
    }

    const rows = matchCommands({ query: q, actions, items, subjects, contextActions, defaultItemActionId: OPEN_ACTION_ID });
    const byGroup = new Map<string, ResultItem[]>();
    for (const row of rows) {
      const g: ActionGroup = row.contextual ? 'context' : row.action.group === 'global' ? 'item' : row.action.group;
      const list = byGroup.get(g) ?? [];
      if (list.length < 10) list.push(toItem(row, 'm'));
      byGroup.set(g, list);
    }
    return GROUP_ORDER.flatMap((g) => {
      const list = byGroup.get(g);
      if (!list?.length) return [];
      return [{ label: g === 'context' ? t('palette.group.page') : groupLabel(g), items: list }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `choose`/`execute` only read state passed here
  }, [step, deferred, actions, items, subjects, contextActions, recent]);

  const count = groups.reduce((n, g) => n + g.items.length, 0);
  const placeholder =
    step.type === 'target' ? t('palette.placeholder.target') : step.type === 'confirm' ? t('palette.placeholder.confirm') : t('palette.placeholder.root');

  return (
    <>
      <CommandPalette
        open={open}
        onClose={onClose}
        query={query}
        onQueryChange={(v) => setQuery(step.type === 'confirm' ? '' : v)}
        groups={groups}
        placeholder={placeholder}
        loading={loading && step.type !== 'confirm'}
        emptyText={step.type === 'target' ? t('palette.empty.target') : t('palette.empty.root')}
        prefix={step.type !== 'root' ? step.action.label : undefined}
        onBackspaceEmpty={step.type !== 'root' ? () => setStep({ type: 'root' }) : undefined}
        status={step.type === 'confirm' ? t('palette.status.confirm') : t('palette.status.results', { count })}
        footer={
          <>
            <span>{t('arclight.commandPalette.move')}</span>
            <span>{step.type === 'confirm' ? t('palette.foot.confirm') : t('palette.foot.run')}</span>
            {step.type !== 'root' ? <span>{t('palette.foot.back')}</span> : <span>{t('palette.foot.help')}</span>}
            <span>{t('arclight.commandPalette.escClose')}</span>
          </>
        }
      />
      <InteractiveSearchModal
        target={interactive ? (interactive.kind === 'movie' ? { movieId: interactive.id } : { seriesId: interactive.id }) : null}
        title={interactive?.title ?? ''}
        onClose={() => setInteractive(null)}
      />
    </>
  );
}
