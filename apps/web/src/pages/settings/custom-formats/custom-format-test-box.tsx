import { useState, type FormEvent } from 'react';
import { Button, Chip, Input, ScoreTag, Select } from '../../../arclight/index.js';
import { useTestCustomFormat } from '../../../hooks/profiles.js';
import { SaveError } from '../shared.js';
import './custom-formats.css';
import { t } from '../../../i18n/index.js';

/** Paste a release title, see which saved formats match and what each profile would score it. */
export function CustomFormatTestBox({ highlightId }: { highlightId?: number | undefined }) {
  const [title, setTitle] = useState('');
  const [mediaType, setMediaType] = useState<'movie' | 'series'>('series');
  const test = useTestCustomFormat();

  const run = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) test.mutate({ title: title.trim(), mediaType, languages: [], qualityId: 0 });
  };

  const matchesThis = test.data && highlightId !== undefined ? test.data.matchedFormats.some((f) => f.id === highlightId) : undefined;

  return (
    <form className="al-cf-test" onSubmit={run}>
      <p className="al-caption">{t('settings.customFormats.customFormatTestBox.testsRunAgainstSavedFormats')}</p>
      <div className="al-cf-test__bar">
        <Input
          mono
          aria-label={t('settings.customFormats.customFormatTestBox.releaseTitle')}
          placeholder={t('settings.customFormats.customFormatTestBox.releaseTitleS01e011080pWeb')}
          spellCheck={false}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        <Select
          aria-label={t('common.mediaType')}
          value={mediaType}
          onChange={(e) => setMediaType(e.currentTarget.value === 'movie' ? 'movie' : 'series')}
          options={[
            { value: 'series', label: t('common.series') },
            { value: 'movie', label: t('common.movie') },
          ]}
        />
        <Button type="submit" loading={test.isPending} disabled={!title.trim()}>
          {t('common.test')}
        </Button>
      </div>
      <SaveError error={test.error} />
      {test.data ? (
        <div className="al-cf-test__result" role="status">
          <div className="al-cf-test__line">
            <span className="al-label">{t('settings.customFormats.customFormatTestBox.matched')}</span>
            {test.data.matchedFormats.length === 0 ? (
              <span className="al-muted">{t('settings.customFormats.customFormatTestBox.nothingMatched')}</span>
            ) : (
              test.data.matchedFormats.map((f) => (
                <Chip key={f.id} tone={f.id === highlightId ? 'accent' : 'default'}>
                  {f.name}
                </Chip>
              ))
            )}
          </div>
          {matchesThis !== undefined ? <p className="al-caption">{matchesThis ? t('settings.customFormats.customFormatTestBox.thisFormatMatches') : t('settings.customFormats.customFormatTestBox.thisFormatDoesNotMatch')}</p> : null}
          {test.data.scores.length ? (
            <div className="al-cf-test__line">
              <span className="al-label">{t('settings.customFormats.customFormatTestBox.scores')}</span>
              {test.data.scores.map((s) => (
                <ScoreTag key={s.profileId} name={s.profileName} score={s.score} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
