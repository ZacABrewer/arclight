import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { PodcastSuggestion, PodcastSuggestionStatus } from '@arclight/shared';
import { Button, Chip, EmptyState, FormRow, Modal, PageHeader, Skeleton, Tabs, Textarea, type ChipTone } from '../../arclight/index.js';
import { formatDate } from '../../components/media/format.js';
import { QueryError } from '../../components/media/media-kit.js';
import { useApproveSuggestion, useDeclineSuggestion, useDeleteSuggestion, usePodcastSuggestions } from '../../hooks/podcasts.js';
import { SquareArt } from '../library/music/music-kit.js';
import { PodcastGate, podcastLink } from './podcast-kit.js';
import { t } from '../../i18n/index.js';

// Podcasts → Suggestions (/podcasts/suggestions): podcasts request-portal users suggested.
// Approve subscribes with the default settings; Decline keeps the row with an optional reason.

const STATUSES: readonly PodcastSuggestionStatus[] = ['pending', 'approved', 'declined'];

export function suggestionStatusLabel(s: PodcastSuggestionStatus): string {
  switch (s) {
    case 'pending':
      return t('podcasts.suggestions.pending');
    case 'approved':
      return t('podcasts.suggestions.approved');
    case 'declined':
      return t('podcasts.suggestions.declined');
  }
}

const STATUS_TONE: Record<PodcastSuggestionStatus, ChipTone> = { pending: 'warn', approved: 'accent', declined: 'muted' };

export function SuggestionStatusChip({ status }: { status: PodcastSuggestionStatus }) {
  return <Chip tone={STATUS_TONE[status]}>{suggestionStatusLabel(status)}</Chip>;
}

export function PodcastSuggestionsPage() {
  return (
    <PodcastGate>
      <PodcastSuggestions />
    </PodcastGate>
  );
}

function PodcastSuggestions() {
  const [status, setStatus] = useState<PodcastSuggestionStatus>('pending');
  return (
    <div className="lib-page">
      <PageHeader index="04" title={t('nav.podcastSuggestions')} />
      <Tabs
        aria-label={t('common.status')}
        value={status}
        onChange={(id) => setStatus(id as PodcastSuggestionStatus)}
        tabs={STATUSES.map((s) => ({ id: s, label: suggestionStatusLabel(s), content: status === s ? <SuggestionList status={s} /> : null }))}
      />
    </div>
  );
}

function SuggestionList({ status }: { status: PodcastSuggestionStatus }) {
  const list = usePodcastSuggestions({ status });
  const [declining, setDeclining] = useState<PodcastSuggestion | null>(null);
  if (list.isPending) return <Skeleton lines={6} />;
  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} title={t('podcasts.suggestions.couldNotLoad')} />;
  if (list.data.length === 0) return <EmptyState title={t('podcasts.suggestions.none')}>{status === 'pending' ? t('podcasts.suggestions.noneHelp') : null}</EmptyState>;
  return (
    <>
      <ul className="pod-results" aria-label={t('nav.podcastSuggestions')}>
        {list.data.map((s) => (
          <SuggestionRow key={s.id} suggestion={s} onDecline={() => setDeclining(s)} />
        ))}
      </ul>
      {declining ? <DeclineDialog suggestion={declining} onClose={() => setDeclining(null)} /> : null}
    </>
  );
}

function SuggestionRow({ suggestion: s, onDecline }: { suggestion: PodcastSuggestion; onDecline: () => void }) {
  const approve = useApproveSuggestion();
  const remove = useDeleteSuggestion();
  return (
    <li className="pod-result" data-testid="suggestion-row">
      <SquareArt src={s.imageUrl} title={s.title} width={64} />
      <div>
        <div className="pod-result__title">{s.title}</div>
        <div className="pod-result__meta">{[s.author, t('podcasts.suggestions.by', { user: s.username }), formatDate(s.createdAt)].filter(Boolean).join(' · ')}</div>
        <div className="pod-feed-url">{s.feedUrl}</div>
        {s.note ? <p className="pod-result__desc">{s.note}</p> : null}
        {s.declineReason ? <p className="pod-result__desc">{t('podcasts.suggestions.reason', { reason: s.declineReason })}</p> : null}
      </div>
      <span className="pod-row-actions">
        <SuggestionStatusChip status={s.status} />
        {s.podcastId !== null ? (
          <Link {...podcastLink({ id: s.podcastId })} className="mk-link">
            {t('common.open')}
          </Link>
        ) : null}
        {s.status === 'pending' ? (
          <>
            <Button size="sm" variant="primary" loading={approve.isPending} aria-label={t('podcasts.suggestions.approveTitle', { title: s.title })} onClick={() => approve.mutate(s.id)}>
              {t('podcasts.suggestions.approve')}
            </Button>
            <Button size="sm" aria-label={t('podcasts.suggestions.declineTitle', { title: s.title })} onClick={onDecline}>
              {t('podcasts.suggestions.decline')}
            </Button>
          </>
        ) : null}
        <Button size="sm" variant="ghost" loading={remove.isPending} aria-label={t('podcasts.suggestions.deleteTitle', { title: s.title })} onClick={() => remove.mutate(s.id)}>
          {t('common.delete')}
        </Button>
      </span>
    </li>
  );
}

function DeclineDialog({ suggestion, onClose }: { suggestion: PodcastSuggestion; onClose: () => void }) {
  const decline = useDeclineSuggestion();
  const [reason, setReason] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title={t('podcasts.suggestions.declineTitle', { title: suggestion.title })}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={decline.isPending} onClick={() => decline.mutate({ id: suggestion.id, reason: reason.trim() || undefined }, { onSuccess: onClose })}>
            {t('podcasts.suggestions.decline')}
          </Button>
        </>
      }
    >
      <FormRow label={t('podcasts.suggestions.reasonLabel')} htmlFor="decline-reason" caption={t('podcasts.suggestions.reasonCaption')}>
        <Textarea id="decline-reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
      </FormRow>
    </Modal>
  );
}
