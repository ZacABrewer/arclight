import { useState, type FormEvent } from 'react';
import { Button, Chip, Input, ScoreTag, Select } from '../../../arclight/index.js';
import { useTestCustomFormat } from '../../../hooks/profiles.js';
import { SaveError } from '../shared.js';
import './custom-formats.css';

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
      <p className="al-caption">Tests run against saved formats. Save first to test changes.</p>
      <div className="al-cf-test__bar">
        <Input
          mono
          aria-label="Release title"
          placeholder="Release.Title.S01E01.1080p.WEB-DL-GROUP"
          spellCheck={false}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        <Select
          aria-label="Media type"
          value={mediaType}
          onChange={(e) => setMediaType(e.currentTarget.value === 'movie' ? 'movie' : 'series')}
          options={[
            { value: 'series', label: 'Series' },
            { value: 'movie', label: 'Movie' },
          ]}
        />
        <Button type="submit" loading={test.isPending} disabled={!title.trim()}>
          Test
        </Button>
      </div>
      <SaveError error={test.error} />
      {test.data ? (
        <div className="al-cf-test__result" role="status">
          <div className="al-cf-test__line">
            <span className="al-label">Matched</span>
            {test.data.matchedFormats.length === 0 ? (
              <span className="al-muted">Nothing matched</span>
            ) : (
              test.data.matchedFormats.map((f) => (
                <Chip key={f.id} tone={f.id === highlightId ? 'accent' : 'default'}>
                  {f.name}
                </Chip>
              ))
            )}
          </div>
          {matchesThis !== undefined ? <p className="al-caption">{matchesThis ? 'This format matches.' : 'This format does not match.'}</p> : null}
          {test.data.scores.length ? (
            <div className="al-cf-test__line">
              <span className="al-label">Scores</span>
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
