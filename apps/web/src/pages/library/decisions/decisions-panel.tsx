import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { DecisionLogBatch, DecisionLogEntry, ReleaseRejection } from '@arclight/shared';
import type { DecisionScope } from '../../../api/decisions.js';
import { Chip, EmptyState, Modal, Paginator, ScoreTag, Tag, Tooltip } from '../../../arclight/index.js';
import { Loading, QualityLabel, QueryError } from '../../../components/media/media-kit.js';
import { useDecisionBatch, useDecisionLog } from '../../../hooks/decisions.js';
import { formatDateTime, relativeTime } from '../../../lib/format.js';
import { batchCounts, decisionRowState, decisionSourceLabel, grabHistorySearch, orderDecisions, pageCount, rejectionTone } from './decisions-model.js';
import '../library.css';
import './decisions.css';
import { t } from '../../../i18n/index.js';

function RejectionChip({ rejection }: { rejection: ReleaseRejection }) {
  const kind = rejection.type === 'temporary' ? t('library.decisions.temporary') : t('library.decisions.permanent');
  return (
    <Tooltip
      content={
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>{rejection.message}</span>
          <span className="mk-muted">{kind}</span>
        </span>
      }
    >
      <button type="button" className="dec-chipbtn" aria-label={t('library.decisions.rejectionLabel', { message: rejection.message, kind })}>
        <Chip tone={rejectionTone(rejection)}>{rejection.message}</Chip>
      </button>
    </Tooltip>
  );
}

function DecisionRow({ row, winnerId }: { row: DecisionLogEntry; winnerId: number | null }) {
  const state = decisionRowState(row, winnerId);
  const highlighted = state === 'grabbed' || state === 'winner';
  return (
    <li className="dec-row" data-state={state} aria-current={highlighted ? 'true' : undefined}>
      <span className="dec-row__rank" aria-label={row.rank === null ? t('library.decisions.unranked') : t('library.decisions.rankLabel', { rank: row.rank })}>
        {row.rank === null ? '—' : `#${row.rank}`}
      </span>
      <div className="dec-row__main">
        <div className="dec-row__title">
          <span className="mk-release-title" title={row.title}>
            {row.title}
          </span>
          {state === 'grabbed' ? <Chip tone="accent">{t('common.grabbed')}</Chip> : null}
          {state === 'winner' ? <Chip tone="default">{t('library.decisions.bestMatch')}</Chip> : null}
        </div>
        <div className="dec-row__meta">
          <QualityLabel quality={row.quality} />
          {row.formats.map((f) => (
            <Tag key={f.id}>{f.name}</Tag>
          ))}
          <ScoreTag name={t('common.score')} score={row.score} />
          {row.approved ? (
            <Chip tone="accent" dot="ring">
              {t('common.approved')}
            </Chip>
          ) : null}
          {row.rejections.map((r, i) => (
            <RejectionChip key={`${r.reason}-${i}`} rejection={r} />
          ))}
        </div>
      </div>
    </li>
  );
}

/** One batch's rows in rank order; the grabbed (or best approved) row is highlighted. */
export function DecisionRows({ batch }: { batch: DecisionLogBatch }) {
  const rows = orderDecisions(batch.decisions);
  if (rows.length === 0) return <span className="mk-muted">{t('library.decisions.noReleasesInThisBatch')}</span>;
  return (
    <ol className="dec-rows" aria-label={t('library.decisions.releasesJudged')}>
      {rows.map((row) => (
        <DecisionRow key={row.id} row={row} winnerId={batch.winnerId} />
      ))}
    </ol>
  );
}

/** Batch header (trigger, time, counts, grabbed, link to the grab in History) plus its rows. */
export function DecisionBatchView({ batch, scope }: { batch: DecisionLogBatch; scope?: DecisionScope | undefined }) {
  const source = decisionSourceLabel(batch.source);
  const historySearch = scope ? grabHistorySearch(batch, scope) : null;
  return (
    <section className="dec-batch" aria-label={t('library.decisions.batchLabel', { source, time: formatDateTime(batch.time) })}>
      <header className="dec-batch__head">
        <Chip tone="neutral" dot="none">
          {source}
        </Chip>
        <time className="dec-batch__time" dateTime={batch.time} title={formatDateTime(batch.time)}>
          {relativeTime(batch.time)}
        </time>
        <span className="dec-batch__counts">{batchCounts(batch)}</span>
        {batch.grabbed ? <Chip tone="accent">{t('common.grabbed')}</Chip> : <Chip tone="muted">{t('library.decisions.nothingGrabbed')}</Chip>}
        {historySearch ? (
          <Link to="/activity/history" search={historySearch} className="al-link dec-batch__link">
            {t('library.decisions.viewGrabInHistory')}
          </Link>
        ) : null}
      </header>
      <DecisionRows batch={batch} />
    </section>
  );
}

/** The decision log of one item (series, episode or movie), newest batch first, paged. */
export function DecisionsPanel({ scope, pageSize = 10, enabled = true }: { scope: DecisionScope; pageSize?: number; enabled?: boolean }) {
  const [page, setPage] = useState(1);
  const log = useDecisionLog(scope, { page, pageSize }, enabled);
  if (log.isError) return <QueryError error={log.error} title={t('library.decisions.couldNotLoadDecisions')} onRetry={() => void log.refetch()} />;
  if (log.isPending) return <Loading lines={3} />;
  const data = log.data;
  if (data.records.length === 0) {
    return <EmptyState title={t('library.decisions.noDecisionsYet')}>{t('library.decisions.noDecisionsHint')}</EmptyState>;
  }
  const pages = pageCount(data.totalRecords, data.pageSize);
  return (
    <div className="dec-list">
      {data.records.map((batch) => (
        <DecisionBatchView key={batch.batchId} batch={batch} scope={scope} />
      ))}
      {pages > 1 ? (
        <div className="dec-foot">
          <Paginator page={page} pageCount={pages} onPageChange={setPage} />
        </div>
      ) : null}
    </div>
  );
}

/** One whole batch by id (History details → "Why this release"). */
export function DecisionBatchModal({ batchId, onClose }: { batchId: string | null; onClose: () => void }) {
  const batch = useDecisionBatch(batchId);
  return (
    <Modal open={batchId !== null} onClose={onClose} title={t('library.decisions.whyThisRelease')} size={1100}>
      {batch.isError ? (
        <QueryError error={batch.error} title={t('library.decisions.couldNotLoadThisBatch')} onRetry={() => void batch.refetch()} />
      ) : batch.isPending ? (
        <Loading lines={3} />
      ) : (
        <DecisionBatchView batch={batch.data} />
      )}
    </Modal>
  );
}
