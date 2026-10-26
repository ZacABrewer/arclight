import { useState } from 'react';
import type { CrossSeedSearchRequest, CrossSeedSearchResult } from '@arclight/shared';
import { Button, EmptyState, KeyValue, Modal, SectionLabel, Table, type Column } from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { useToast } from '../../components/toast.js';
import { useCrossSeedSearch } from '../../hooks/cross-seed.js';
import { formatSize } from '../../lib/format.js';
import { t } from '../../i18n/index.js';

// "Search cross-seeds": POST /crossseed/search for one file, series or movie, then the report
// (files searched, candidates, added, skipped with reasons). A search that found nothing is a
// toast; anything else opens the report modal.

export type CrossSeedTarget = { mediaFileId: number } | { seriesId: number } | { movieId: number };

/** The request body for a target: exactly one of mediaFileId | seriesId | movieId. */
export function crossSeedSearchBody(target: CrossSeedTarget): CrossSeedSearchRequest {
  if ('mediaFileId' in target) return { mediaFileId: target.mediaFileId };
  if ('seriesId' in target) return { seriesId: target.seriesId };
  return { movieId: target.movieId };
}

/** One-line summary of a search report. */
export function crossSeedSummary(r: CrossSeedSearchResult): string {
  return t('features.crossSeed.summary', {
    files: r.filesSearched,
    candidates: r.candidates,
    added: r.added.length,
    skipped: r.skipped.length,
  });
}

type Skip = CrossSeedSearchResult['skipped'][number];
type Added = CrossSeedSearchResult['added'][number];

/** The report modal body: counts, then the added and skipped releases. */
export function CrossSeedReport({ result }: { result: CrossSeedSearchResult }) {
  const addedColumns: Column<Added>[] = [
    { key: 'title', header: t('common.title'), cell: (r) => r.title },
    { key: 'indexer', header: t('common.indexer'), muted: true, cell: (r) => r.indexerName ?? '—' },
    { key: 'hash', header: t('features.crossSeed.infoHash'), mono: true, cell: (r) => r.infoHash },
    { key: 'size', header: t('common.size'), mono: true, align: 'right', cell: (r) => formatSize(r.size) },
  ];
  const skippedColumns: Column<Skip>[] = [
    { key: 'title', header: t('common.title'), cell: (r) => r.title },
    { key: 'reason', header: t('features.crossSeed.reason'), muted: true, cell: (r) => r.reason },
  ];
  return (
    <div className="mk-stack-sm" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <KeyValue
        layout="grid"
        columns={4}
        items={[
          { label: t('features.crossSeed.filesSearched'), value: String(result.filesSearched) },
          { label: t('features.crossSeed.candidates'), value: String(result.candidates) },
          { label: t('common.added'), value: String(result.added.length) },
          { label: t('features.crossSeed.skipped'), value: String(result.skipped.length) },
        ]}
      />
      <section aria-label={t('common.added')}>
        <SectionLabel count={result.added.length}>{t('common.added')}</SectionLabel>
        <Table
          caption={t('common.added')}
          columns={addedColumns}
          rows={result.added}
          rowKey={(r) => r.id}
          density="dense"
          sortable={false}
          empty={<EmptyState title={t('features.crossSeed.nothingAdded')} />}
        />
      </section>
      {result.skipped.length > 0 ? (
        <section aria-label={t('features.crossSeed.skipped')}>
          <SectionLabel count={result.skipped.length}>{t('features.crossSeed.skipped')}</SectionLabel>
          <Table
            caption={t('features.crossSeed.skipped')}
            columns={skippedColumns}
            rows={result.skipped.map((s, i) => ({ ...s, key: i }))}
            rowKey={(r) => r.key}
            density="dense"
            sortable={false}
          />
        </section>
      ) : null}
    </div>
  );
}

export interface CrossSeedSearchButtonProps {
  target: CrossSeedTarget;
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary' | 'ghost';
  /** Accessible name (icon-less rows add the file name). */
  'aria-label'?: string;
}

/** "Search cross-seeds" button with its report. Hidden for non-admins. */
export function CrossSeedSearchButton({ target, size = 'md', variant = 'secondary', 'aria-label': ariaLabel }: CrossSeedSearchButtonProps) {
  const { isAdmin } = useAuth();
  const search = useCrossSeedSearch();
  const toast = useToast();
  const [result, setResult] = useState<CrossSeedSearchResult | null>(null);
  if (!isAdmin) return null;

  const run = () =>
    search.mutate(crossSeedSearchBody(target), {
      onSuccess: (r) => {
        if (r.candidates === 0 && r.added.length === 0 && r.skipped.length === 0) {
          toast.push({ tone: 'info', title: t('features.crossSeed.noCrossSeedsFound'), message: crossSeedSummary(r) });
        } else {
          setResult(r);
        }
      },
    });

  return (
    <>
      <Button size={size} variant={variant} loading={search.isPending} onClick={run} aria-label={ariaLabel}>
        {t('features.crossSeed.searchCrossSeeds')}
      </Button>
      {result ? (
        <Modal
          open
          size={640}
          onClose={() => setResult(null)}
          title={t('features.crossSeed.crossSeedSearch')}
          footer={
            <Button variant="primary" onClick={() => setResult(null)}>
              {t('common.close')}
            </Button>
          }
        >
          <p className="al-caption" style={{ marginTop: 0 }}>
            {crossSeedSummary(result)}
          </p>
          <CrossSeedReport result={result} />
        </Modal>
      ) : null}
    </>
  );
}
