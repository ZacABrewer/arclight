import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { PodcastOpmlImportResult, PodcastPreview, PodcastSearchResult, PodcastSearchSource, PodcastSubscriptionSettings } from '@arclight/shared';
import { PodcastSubscriptionSettings as SubscriptionDefaults } from '@arclight/shared';
import { Banner, Button, Chip, EmptyState, FormRow, Input, PageHeader, Pane, Select, Skeleton, Tabs, Textarea, Toggle } from '../../arclight/index.js';
import { errorMessage } from '../../api/client.js';
import { TagPicker } from '../../components/forms/tag-picker.js';
import { formatDate } from '../../components/media/format.js';
import { QueryError } from '../../components/media/media-kit.js';
import { useToast } from '../../components/toast.js';
import { useAddPodcast, useImportOpml, usePodcastLookup, usePodcastPreview, usePodcastSettings } from '../../hooks/podcasts.js';
import { SquareArt } from '../library/music/music-kit.js';
import { PodcastGate, SubscriptionSettingsFields, episodeDuration, podcastLink } from './podcast-kit.js';
import { t } from '../../i18n/index.js';

// Podcasts → Add podcast (/podcasts/add): search the iTunes or Podcast Index directory, paste an
// RSS URL (preview first, then subscribe with the defaults from Settings → Podcasts), or import
// an OPML file from another podcast app.

type AddTab = 'search' | 'rss' | 'opml';

export function PodcastAddPage() {
  return (
    <PodcastGate>
      <PodcastAdd />
    </PodcastGate>
  );
}

function PodcastAdd() {
  const [tab, setTab] = useState<AddTab>('search');
  return (
    <div className="lib-page">
      <PageHeader index="03" title={t('nav.addPodcast')} />
      <Tabs
        aria-label={t('nav.addPodcast')}
        value={tab}
        onChange={(id) => setTab(id as AddTab)}
        tabs={[
          { id: 'search', label: t('podcasts.add.searchTab'), content: <SearchTab /> },
          { id: 'rss', label: t('podcasts.add.rssTab'), content: <RssTab /> },
          { id: 'opml', label: t('podcasts.add.opmlTab'), content: <OpmlTab /> },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------

function SearchTab() {
  const [draft, setDraft] = useState('');
  const [term, setTerm] = useState('');
  const [source, setSource] = useState<PodcastSearchSource | ''>('');
  const results = usePodcastLookup(term, source || undefined);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTerm(draft.trim());
  };
  return (
    <div className="mk-stack-sm">
      <form className="mk-row" onSubmit={submit} role="search">
        <Input type="search" aria-label={t('podcasts.add.searchLabel')} placeholder={t('podcasts.add.searchPlaceholder')} value={draft} onChange={(e) => setDraft(e.currentTarget.value)} />
        <Select
          aria-label={t('podcasts.add.source')}
          value={source}
          onChange={(e) => setSource(e.currentTarget.value as PodcastSearchSource | '')}
          options={[
            { value: '', label: t('podcasts.add.sourceDefault') },
            { value: 'itunes', label: t('podcasts.add.itunes') },
            { value: 'podcastindex', label: t('podcasts.add.podcastIndex') },
          ]}
        />
        <Button type="submit" variant="primary" disabled={!draft.trim()}>
          {t('common.search')}
        </Button>
      </form>
      {!term ? (
        <EmptyState title={t('podcasts.add.searchHint')}>{t('podcasts.add.searchHelp')}</EmptyState>
      ) : results.isPending ? (
        <Skeleton lines={6} />
      ) : results.isError ? (
        <QueryError error={results.error} onRetry={() => void results.refetch()} title={t('podcasts.add.searchFailed')} />
      ) : results.data.length === 0 ? (
        <EmptyState title={t('podcasts.add.noResults', { term })} />
      ) : (
        <ul className="pod-results" aria-label={t('podcasts.add.results')}>
          {results.data.map((r) => (
            <SearchResultRow key={`${r.source}-${r.feedUrl}`} result={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchResultRow({ result: r }: { result: PodcastSearchResult }) {
  const add = useAddPodcast();
  const toast = useToast();
  // A subscription made here marks the row at once (directory results are a snapshot).
  const [subscribedId, setSubscribedId] = useState<number | null>(r.podcastId);
  return (
    <li className="pod-result">
      <SquareArt src={r.imageUrl} title={r.title} width={64} />
      <div>
        <div className="pod-result__title">{r.title}</div>
        <div className="pod-result__meta">
          {[r.author, r.categories.slice(0, 2).join(', ') || null, r.episodeCount != null ? t('podcasts.episodeCount', { count: r.episodeCount }) : null].filter(Boolean).join(' · ')}
        </div>
        {r.description ? <p className="pod-result__desc">{r.description}</p> : null}
      </div>
      {subscribedId !== null ? (
        <span className="mk-row">
          <Chip tone="accent" data-testid="already-subscribed">
            {t('podcasts.add.subscribed')}
          </Chip>
          <Link {...podcastLink({ id: subscribedId })} className="mk-link">
            {t('common.open')}
          </Link>
        </span>
      ) : (
        <Button
          variant="primary"
          size="sm"
          loading={add.isPending}
          aria-label={t('podcasts.add.subscribeTo', { title: r.title })}
          onClick={() =>
            add.mutate(
              { feedUrl: r.feedUrl, ...(r.itunesId ? { itunesId: r.itunesId } : {}), ...(r.podcastIndexId ? { podcastIndexId: r.podcastIndexId } : {}) },
              {
                onSuccess: (p) => {
                  setSubscribedId(p.id);
                  toast.push({ tone: 'ok', title: t('podcasts.add.subscribedTo', { title: p.title }) });
                },
              },
            )
          }
        >
          {t('podcasts.add.subscribe')}
        </Button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------
// RSS URL
// ---------------------------------------------------------------------------------------

const FALLBACK_DEFAULTS: PodcastSubscriptionSettings = SubscriptionDefaults.parse({});

function RssTab() {
  const preview = usePodcastPreview();
  const add = useAddPodcast();
  const podcastSettings = usePodcastSettings();
  const navigate = useNavigate();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [settings, setSettings] = useState<PodcastSubscriptionSettings>(FALLBACK_DEFAULTS);
  const [tags, setTags] = useState<number[]>([]);
  const [monitored, setMonitored] = useState(true);
  const defaults = podcastSettings.data?.defaults;
  // The per-podcast fields start from Settings → Podcasts → Defaults once they arrive.
  useEffect(() => {
    if (defaults) setSettings(defaults);
  }, [defaults]);

  const runPreview = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) preview.mutate(url.trim());
  };
  const data: PodcastPreview | undefined = preview.data;

  return (
    <div className="mk-stack-sm">
      <form className="mk-row" onSubmit={runPreview}>
        <Input
          type="url"
          mono
          spellCheck={false}
          autoComplete="off"
          aria-label={t('podcasts.feedUrl')}
          placeholder="https://example.com/feed.xml"
          value={url}
          onChange={(e) => {
            setUrl(e.currentTarget.value);
            preview.reset();
          }}
        />
        <Button type="submit" disabled={!url.trim()} loading={preview.isPending}>
          {t('podcasts.add.preview')}
        </Button>
      </form>
      <p className="al-caption">{t('podcasts.add.rssHelp')}</p>
      {preview.isError ? (
        <Banner tone="danger">
          <strong>{t('podcasts.add.previewFailed')}</strong> {errorMessage(preview.error)}
        </Banner>
      ) : null}
      {data ? (
        <Pane title={data.title} aria-label={t('podcasts.add.previewOf', { title: data.title })}>
          <div className="pod-preview" data-testid="feed-preview">
            <SquareArt src={data.imageUrl} title={data.title} width={120} />
            <div>
              <div className="pod-result__meta">{[data.author, t('podcasts.episodeCount', { count: data.episodeCount })].filter(Boolean).join(' · ')}</div>
              <div className="pod-feed-url">{data.feedUrl}</div>
              {data.description ? <p className="pod-result__desc">{data.description}</p> : null}
              {data.latestEpisodes.length ? (
                <ul aria-label={t('podcasts.add.latestEpisodes')}>
                  {data.latestEpisodes.slice(0, 5).map((ep, i) => (
                    <li key={`${ep.title}-${i}`}>
                      {ep.title}
                      <span className="al-num"> · {formatDate(ep.publishedAt)} · {episodeDuration(ep.durationSeconds)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
          {data.podcastId !== null ? (
            <p className="mk-row" style={{ marginTop: 12 }}>
              <Chip tone="accent" data-testid="already-subscribed">
                {t('podcasts.add.subscribed')}
              </Chip>
              <Link {...podcastLink({ id: data.podcastId })} className="mk-link">
                {t('common.open')}
              </Link>
            </p>
          ) : (
            <form
              className="mk-stack-sm"
              style={{ marginTop: 16 }}
              onSubmit={(e) => {
                e.preventDefault();
                add.mutate(
                  { feedUrl: url.trim(), settings, tags, monitored },
                  {
                    onSuccess: (p) => {
                      toast.push({ tone: 'ok', title: t('podcasts.add.subscribedTo', { title: p.title }) });
                      void navigate(podcastLink(p));
                    },
                  },
                );
              }}
            >
              <FormRow label={t('status.monitored')} htmlFor="add-podcast-monitored" captionInline caption={t('podcasts.monitoredCaption')}>
                <Toggle id="add-podcast-monitored" checked={monitored} onChange={(e) => setMonitored(e.currentTarget.checked)} />
              </FormRow>
              <FormRow label={t('common.tags')} htmlFor="add-podcast-tags">
                <TagPicker id="add-podcast-tags" value={tags} onChange={setTags} />
              </FormRow>
              <SubscriptionSettingsFields value={settings} onChange={setSettings} />
              <div>
                <Button type="submit" variant="primary" loading={add.isPending}>
                  {t('podcasts.add.subscribe')}
                </Button>
              </div>
            </form>
          )}
        </Pane>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// OPML
// ---------------------------------------------------------------------------------------

function OpmlTab() {
  const importOpml = useImportOpml();
  const [opml, setOpml] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [tags, setTags] = useState<number[]>([]);
  const result: PodcastOpmlImportResult | undefined = importOpml.data;

  return (
    <div className="mk-stack-sm">
      <p className="al-caption">{t('podcasts.add.opmlHelp')}</p>
      <form
        className="mk-stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (opml.trim()) importOpml.mutate({ opml, tags });
        }}
      >
        <FormRow label={t('podcasts.add.opmlFile')} htmlFor="opml-file" caption={fileName ?? undefined}>
          <input
            id="opml-file"
            type="file"
            accept=".opml,.xml,text/x-opml,text/xml,application/xml"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (!file) return;
              setFileName(file.name);
              void file.text().then(setOpml);
            }}
          />
        </FormRow>
        <FormRow label={t('podcasts.add.opmlPaste')} htmlFor="opml-text">
          <Textarea id="opml-text" mono rows={8} spellCheck={false} value={opml} onChange={(e) => setOpml(e.currentTarget.value)} placeholder='<opml version="2.0">…</opml>' />
        </FormRow>
        <FormRow label={t('common.tags')} htmlFor="opml-tags">
          <TagPicker id="opml-tags" value={tags} onChange={setTags} />
        </FormRow>
        <div>
          <Button type="submit" variant="primary" disabled={!opml.trim()} loading={importOpml.isPending}>
            {t('podcasts.add.import')}
          </Button>
        </div>
      </form>
      {result ? <OpmlResult result={result} /> : null}
    </div>
  );
}

export function OpmlResult({ result }: { result: PodcastOpmlImportResult }) {
  return (
    <Pane title={t('podcasts.add.importResult')} aria-label={t('podcasts.add.importResult')}>
      <div className="pod-import-result" data-testid="opml-result">
        <p>
          {t('podcasts.add.importSummary', { added: result.added.length, existing: result.existing.length, failed: result.failed.length })}
        </p>
        {result.added.length ? (
          <div>
            <strong>{t('podcasts.add.added')}</strong>
            <ul>
              {result.added.map((p) => (
                <li key={p.id}>
                  <Link {...podcastLink(p)} className="mk-link">
                    {p.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {result.existing.length ? (
          <div>
            <strong>{t('podcasts.add.existing')}</strong>
            <ul>
              {result.existing.map((p) => (
                <li key={p.id}>{p.title}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {result.failed.length ? (
          <div>
            <strong>{t('podcasts.add.failed')}</strong>
            <ul>
              {result.failed.map((f, i) => (
                <li key={`${f.feedUrl}-${i}`}>
                  {f.title ?? f.feedUrl} — <span className="pod-error">{f.error}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Pane>
  );
}
