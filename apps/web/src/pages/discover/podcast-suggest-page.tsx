import { useState, type FormEvent } from 'react';
import { Permission, type PodcastSearchResult } from '@arclight/shared';
import { Button, Chip, EmptyState, FormRow, Input, PageHeader, SectionHead, Skeleton, Textarea } from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { formatDate } from '../../components/media/format.js';
import { QueryError } from '../../components/media/media-kit.js';
import { useToast } from '../../components/toast.js';
import { usePermissions } from '../../features/requests/status.js';
import { useCreateSuggestion, usePodcastSearch, usePodcastSuggestions } from '../../hooks/podcasts.js';
import { SquareArt } from '../library/music/music-kit.js';
import { PodcastGate } from '../podcasts/podcast-kit.js';
import { SuggestionStatusChip } from '../podcasts/podcast-suggestions.js';
import { t } from '../../i18n/index.js';

// Discover → Podcasts (/discover/podcasts and /portal/podcasts): signed-in users search the
// podcast directory or paste an RSS URL and suggest a podcast with an optional note; an admin
// approves it under Podcasts → Suggestions. "My suggestions" lists theirs with the outcome.

export function PodcastSuggestPage() {
  return (
    <PodcastGate>
      <PodcastSuggest />
    </PodcastGate>
  );
}

/** Signed in, a REQUEST-type permission, and the user's request types include podcasts. */
export function useCanSuggestPodcast(): { signedIn: boolean; allowed: boolean } {
  const { status } = useAuth();
  const { can, allows } = usePermissions();
  const signedIn = status ? status.authenticated : true;
  return { signedIn, allowed: signedIn && can(Permission.REQUEST, Permission.REQUEST_MUSIC, Permission.REQUEST_AUDIOBOOK) && allows('podcast') };
}

function PodcastSuggest() {
  const { signedIn, allowed } = useCanSuggestPodcast();
  return (
    <>
      <PageHeader index="02" title={t('common.podcasts')} />
      {!signedIn ? (
        <EmptyState title={t('podcasts.suggest.signIn')} />
      ) : !allowed ? (
        <EmptyState title={t('podcasts.suggest.notAllowed')} />
      ) : (
        <div className="mk-stack-sm">
          <p className="al-caption">{t('podcasts.suggest.intro')}</p>
          <SuggestSearch />
          <SuggestByUrl />
          <MySuggestions />
        </div>
      )}
    </>
  );
}

function SuggestSearch() {
  const [draft, setDraft] = useState('');
  const [term, setTerm] = useState('');
  const results = usePodcastSearch(term);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTerm(draft.trim());
  };
  return (
    <section aria-label={t('podcasts.add.searchTab')} className="mk-stack-sm">
      <form className="mk-row" onSubmit={submit} role="search">
        <Input type="search" aria-label={t('podcasts.add.searchLabel')} placeholder={t('podcasts.add.searchPlaceholder')} value={draft} onChange={(e) => setDraft(e.currentTarget.value)} />
        <Button type="submit" variant="primary" disabled={!draft.trim()}>
          {t('common.search')}
        </Button>
      </form>
      {!term ? null : results.isPending ? (
        <Skeleton lines={4} />
      ) : results.isError ? (
        <QueryError error={results.error} onRetry={() => void results.refetch()} title={t('podcasts.add.searchFailed')} />
      ) : results.data.length === 0 ? (
        <EmptyState title={t('podcasts.add.noResults', { term })} />
      ) : (
        <ul className="pod-results" aria-label={t('podcasts.add.results')}>
          {results.data.map((r) => (
            <SuggestResultRow key={`${r.source}-${r.feedUrl}`} result={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SuggestResultRow({ result: r }: { result: PodcastSearchResult }) {
  const create = useCreateSuggestion();
  const toast = useToast();
  const [sent, setSent] = useState(false);
  return (
    <li className="pod-result">
      <SquareArt src={r.imageUrl} title={r.title} width={64} />
      <div>
        <div className="pod-result__title">{r.title}</div>
        <div className="pod-result__meta">{[r.author, r.episodeCount != null ? t('podcasts.episodeCount', { count: r.episodeCount }) : null].filter(Boolean).join(' · ')}</div>
        {r.description ? <p className="pod-result__desc">{r.description}</p> : null}
      </div>
      {r.podcastId !== null ? (
        <Chip tone="accent" data-testid="already-subscribed">
          {t('podcasts.suggest.inLibrary')}
        </Chip>
      ) : sent ? (
        <Chip tone="warn">{t('podcasts.suggestions.pending')}</Chip>
      ) : (
        <Button
          size="sm"
          variant="primary"
          loading={create.isPending}
          aria-label={t('podcasts.suggest.suggestTitle', { title: r.title })}
          onClick={() =>
            create.mutate(
              { feedUrl: r.feedUrl, title: r.title, ...(r.itunesId ? { itunesId: r.itunesId } : {}), ...(r.podcastIndexId ? { podcastIndexId: r.podcastIndexId } : {}) },
              {
                onSuccess: () => {
                  setSent(true);
                  toast.push({ tone: 'ok', title: t('podcasts.suggest.sent', { title: r.title }) });
                },
              },
            )
          }
        >
          {t('podcasts.suggest.suggest')}
        </Button>
      )}
    </li>
  );
}

function SuggestByUrl() {
  const create = useCreateSuggestion();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  return (
    <section aria-label={t('podcasts.add.rssTab')}>
      <SectionHead label={t('podcasts.add.rssTab')} />
      <form
        className="mk-stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (!url.trim()) return;
          create.mutate(
            { feedUrl: url.trim(), ...(note.trim() ? { note: note.trim() } : {}) },
            {
              onSuccess: (s) => {
                setUrl('');
                setNote('');
                toast.push({ tone: 'ok', title: t('podcasts.suggest.sent', { title: s.title }) });
              },
            },
          );
        }}
      >
        <FormRow label={t('podcasts.feedUrl')} htmlFor="suggest-feed-url">
          <Input id="suggest-feed-url" type="url" mono spellCheck={false} autoComplete="off" placeholder="https://example.com/feed.xml" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
        </FormRow>
        <FormRow label={t('podcasts.suggest.note')} htmlFor="suggest-note" caption={t('podcasts.suggest.noteCaption')}>
          <Textarea id="suggest-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        </FormRow>
        <div>
          <Button type="submit" variant="primary" disabled={!url.trim()} loading={create.isPending}>
            {t('podcasts.suggest.suggest')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function MySuggestions() {
  const list = usePodcastSuggestions({ mine: true });
  return (
    <section aria-label={t('podcasts.suggest.mine')}>
      <SectionHead label={t('podcasts.suggest.mine')} />
      {list.isPending ? (
        <Skeleton lines={3} />
      ) : list.isError ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} title={t('podcasts.suggestions.couldNotLoad')} />
      ) : list.data.length === 0 ? (
        <EmptyState title={t('podcasts.suggest.noneYet')} />
      ) : (
        <ul className="pod-results" data-testid="my-suggestions">
          {list.data.map((s) => (
            <li key={s.id} className="pod-result">
              <SquareArt src={s.imageUrl} title={s.title} width={48} />
              <div>
                <div className="pod-result__title">{s.title}</div>
                <div className="pod-result__meta">{formatDate(s.createdAt)}</div>
                {s.declineReason ? <p className="pod-result__desc">{t('podcasts.suggestions.reason', { reason: s.declineReason })}</p> : null}
              </div>
              <SuggestionStatusChip status={s.status} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
