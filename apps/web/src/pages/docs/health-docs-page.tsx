import { useEffect, useMemo, useState } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { Input, PageHeader, Pane } from '../../arclight/index.js';
import type { AppPath } from '../../router.js';
import { HEALTH_DOCS, type HealthDoc } from './health-docs-data.js';
import './health-docs.css';
import { t } from '../../i18n/index.js';

/** Entries matching `q` (title, cause, check id or anchor), case-insensitive. */
export function filterHealthDocs(q: string, docs: readonly HealthDoc[] = HEALTH_DOCS): HealthDoc[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...docs];
  return docs.filter((d) => [d.title, d.cause, d.anchor, ...d.sources].some((s) => s.toLowerCase().includes(needle)));
}

function DocEntry({ doc, active }: { doc: HealthDoc; active: boolean }) {
  return (
    <article id={doc.anchor} className="al-hdoc" data-active={active || undefined} aria-labelledby={`${doc.anchor}-title`}>
      <h2 id={`${doc.anchor}-title`} className="al-title-m al-hdoc__title">
        <a href={`#${doc.anchor}`} className="al-hdoc__anchor">
          {doc.title}
        </a>
      </h2>
      <p className="al-hdoc__sources al-num">{doc.sources.join(' · ')}</p>
      <dl className="al-hdoc__body">
        <dt className="al-label">{t('docs.healthDocs.cause')}</dt>
        <dd>{doc.cause}</dd>
        <dt className="al-label">{t('common.fix')}</dt>
        <dd>
          <ol className="al-hdoc__steps">
            {doc.fix.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {doc.link ? (
            <Link to={doc.link.to as AppPath} className="al-link">
              {t('docs.healthDocs.openLabel', { label: doc.link.label })}
            </Link>
          ) : null}
        </dd>
      </dl>
    </article>
  );
}

/** System → Health docs (/docs/system/health): source → cause → fix for every health check. */
export function HealthDocsPage() {
  const hash = useRouterState({ select: (s) => s.location.hash });
  const [q, setQ] = useState('');
  const docs = useMemo(() => filterHealthDocs(q), [q]);
  const anchor = hash.replace(/^#/, '');

  useEffect(() => {
    document.title = t('docs.healthDocs.healthDocsSystemArclight');
  }, []);
  useEffect(() => {
    if (!anchor) return;
    const el = document.getElementById(anchor);
    el?.scrollIntoView?.({ block: 'start' });
  }, [anchor]);

  return (
    <>
      <PageHeader index="10" title={t('docs.healthDocs.healthDocs')} subtitle={t('docs.healthDocs.whatEachHealthCheckMeans')}>
        <Input type="search" aria-label={t('docs.healthDocs.filterHealthDocs')} placeholder={t('docs.healthDocs.filterByCheckOrText')} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
      </PageHeader>
      <Pane flush>
        <div className="al-hdocs">
          {docs.length === 0 ? <p className="al-caption al-hdocs__none">{t('docs.healthDocs.noCheckMatchesQ', { q })}</p> : docs.map((d) => <DocEntry key={d.anchor} doc={d} active={d.anchor === anchor} />)}
        </div>
      </Pane>
    </>
  );
}
