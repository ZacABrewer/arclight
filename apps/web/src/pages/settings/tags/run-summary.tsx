import type { TagRuleRunResult } from '@arclight/shared';
import { Banner, Chip, KeyValue } from '../../../arclight/index.js';
import { entityLabel, usageKindLabel } from './tags-model.js';
import { t } from '../../../i18n/index.js';

/** What a (dry) run adds and removes: counts, the tags, new tags, and the behaviour warning. */
export function RunSummary({ result, compact = false }: { result: TagRuleRunResult; compact?: boolean }) {
  const byType = Object.entries(result.matchedByType).filter(([, n]) => n > 0);
  const adds = compact ? result.add.slice(0, 5) : result.add;
  const removes = compact ? result.remove.slice(0, 5) : result.remove;
  return (
    <div className="tg-run">
      <KeyValue
        items={[
          { label: t('settings.tags.run.evaluated'), value: String(result.itemsEvaluated) },
          { label: t('settings.tags.run.matched'), value: String(result.itemsMatched) },
          { label: t('settings.tags.run.changed'), value: String(result.itemsChanged) },
        ]}
      />
      {byType.length ? (
        <p className="al-caption">
          {byType.map(([type, n]) => t('settings.tags.run.matchedType', { count: n, type: entityLabel(type as never) })).join(' · ')}
        </p>
      ) : null}
      {adds.length === 0 && removes.length === 0 ? <p className="al-caption">{t('settings.tags.run.noChanges')}</p> : null}
      {adds.length ? (
        <ul className="tg-run__list" aria-label={t('settings.tags.run.adds')}>
          {adds.map((a) => (
            <li key={a.label}>
              {t('settings.tags.run.wouldAdd', { label: a.label, count: a.count })}
              {a.isNew ? (
                <>
                  {' '}
                  <Chip tone="accent" dot="none">
                    {t('settings.tags.run.newTag')}
                  </Chip>
                </>
              ) : null}
            </li>
          ))}
          {compact && result.add.length > adds.length ? <li className="al-caption">{t('settings.tags.run.more', { count: result.add.length - adds.length })}</li> : null}
        </ul>
      ) : null}
      {removes.length ? (
        <ul className="tg-run__list" aria-label={t('settings.tags.run.removes')}>
          {removes.map((r) => (
            <li key={r.label}>{t('settings.tags.run.wouldRemove', { label: r.label, count: r.count })}</li>
          ))}
          {compact && result.remove.length > removes.length ? <li className="al-caption">{t('settings.tags.run.more', { count: result.remove.length - removes.length })}</li> : null}
        </ul>
      ) : null}
      {result.behaviour.length ? (
        <div className="tg-run__behaviour">
          <Banner tone="warn">{t('settings.tags.run.behaviourTitle')}</Banner>
          <ul className="tg-run__list" aria-label={t('settings.tags.run.behaviourTitle')}>
            {result.behaviour.map((b) => (
              <li key={b.label}>
                <span className="tg-strong">{b.label}</span>:{' '}
                {Object.entries(b.uses)
                  .map(([kind, n]) => `${n} × ${usageKindLabel(kind)}`)
                  .join(', ')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!compact && result.samples.length ? (
        <details className="tg-run__samples">
          <summary>{t('settings.tags.run.samples', { count: result.samples.length })}</summary>
          <ul className="tg-run__list">
            {result.samples.map((s) => (
              <li key={`${s.entityType}:${s.id}`}>
                <span className="tg-strong">{s.title}</span> <span className="al-caption">({entityLabel(s.entityType)})</span>
                {s.add.length ? ` +${s.add.join(', +')}` : ''}
                {s.remove.length ? ` −${s.remove.join(', −')}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
