import type { ImportListPreviewItem, ImportListPreviewOutcome, ImportListPreviewResult } from '@arclight/shared';
import { Chip, Table, type ChipTone, type Column } from '../../../arclight/index.js';
import { t } from '../../../i18n/index.js';

// "This list would add 37 titles": the result of POST /importlist/preview, with why the rest
// would be skipped.

const OUTCOME_ORDER: ImportListPreviewOutcome[] = ['add', 'inLibrary', 'excluded', 'rating', 'votes', 'year', 'streaming'];

export const OUTCOME_LABELS: Record<ImportListPreviewOutcome, string> = {
  get add() {
    return t('settings.importLists.preview.outcomeAdd');
  },
  get inLibrary() {
    return t('common.inLibrary');
  },
  get excluded() {
    return t('settings.importLists.itemsTable.excluded');
  },
  get rating() {
    return t('settings.importLists.preview.outcomeRating');
  },
  get votes() {
    return t('settings.importLists.preview.outcomeVotes');
  },
  get year() {
    return t('settings.importLists.preview.outcomeYear');
  },
  get streaming() {
    return t('settings.importLists.preview.outcomeStreaming');
  },
};

const TONES: Record<ImportListPreviewOutcome, ChipTone> = {
  add: 'accent',
  inLibrary: 'neutral',
  excluded: 'warn',
  rating: 'muted',
  votes: 'muted',
  year: 'muted',
  streaming: 'muted',
};

export function PreviewPanel({ result }: { result: ImportListPreviewResult }) {
  if (!result.ok) {
    return (
      <p className="al-inline-error" role="alert">
        {result.error?.message ?? t('settings.importLists.preview.failed')}
      </p>
    );
  }
  const counts = result.counts ?? {};
  const items = result.items ?? [];
  const columns: Array<Column<ImportListPreviewItem>> = [
    { key: 'title', header: t('common.title'), sortValue: (i) => i.title, cell: (i) => i.title },
    { key: 'year', header: t('common.year'), sortValue: (i) => i.year ?? null, cell: (i) => i.year ?? '—', width: '80px', mono: true },
    {
      key: 'outcome',
      header: t('settings.importLists.preview.outcome'),
      sortValue: (i) => OUTCOME_ORDER.indexOf(i.outcome),
      cell: (i) => (
        <Chip tone={TONES[i.outcome]} dot="none" title={i.streamingOn?.join(', ')}>
          {i.outcome === 'streaming' && i.streamingOn?.length ? t('settings.importLists.preview.onServices', { services: i.streamingOn.join(', ') }) : OUTCOME_LABELS[i.outcome]}
        </Chip>
      ),
    },
  ];
  return (
    <section className="al-il-preview" aria-label={t('settings.importLists.preview.title')}>
      <p className="al-il-preview__headline" role="status" data-testid="preview-would-add">
        {t('settings.importLists.preview.wouldAdd', { count: result.wouldAdd ?? 0 })}
      </p>
      <div className="al-chip-row">
        <span className="al-caption">{t('settings.importLists.preview.found', { count: result.itemCount ?? 0 })}</span>
        {OUTCOME_ORDER.filter((o) => o !== 'add' && counts[o]).map((o) => (
          <Chip key={o} tone={TONES[o]} dot="none">
            {OUTCOME_LABELS[o]} <span className="al-num">{counts[o]}</span>
          </Chip>
        ))}
        {result.unresolved ? (
          <Chip tone="warn" dot="none" title={t('settings.importLists.preview.unresolvedHelp')}>
            {t('settings.importLists.preview.unresolved')} <span className="al-num">{result.unresolved}</span>
          </Chip>
        ) : null}
      </div>
      {items.length ? (
        <Table
          caption={t('settings.importLists.preview.title')}
          density="dense"
          columns={columns}
          rows={items}
          rowKey={(i) => `${i.mediaType}-${i.tmdbId}`}
          sortable
          empty={t('settings.importLists.itemsTable.theListReturnedNoItems')}
        />
      ) : null}
    </section>
  );
}
