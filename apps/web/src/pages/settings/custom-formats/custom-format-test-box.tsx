import { useState, type FormEvent } from 'react';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { Input, Select } from '../../../components/form.js';
import { useTestCustomFormat } from '../../../hooks/profiles.js';
import { SaveError } from '../shared.js';

/** Paste a release title, see which saved formats match and what each profile would score it. */
export function CustomFormatTestBox({ highlightId }: { highlightId?: number | undefined }) {
  const [title, setTitle] = useState('');
  const [mediaType, setMediaType] = useState<'movie' | 'series'>('series');
  const test = useTestCustomFormat();

  const run = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) test.mutate({ title: title.trim(), mediaType, languages: [], qualityId: 0 });
  };

  return (
    <form className="test-box test-box-column" onSubmit={run}>
      <p className="field-hint">Tests run against saved formats; save first to test changes.</p>
      <div className="row">
        <Input aria-label="Release title" placeholder="Release.Title.S01E01.1080p.WEB-DL-GROUP" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
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
        <div className="test-result" role="status">
          <div>
            <strong>Matched:</strong>{' '}
            {test.data.matchedFormats.length === 0
              ? 'nothing'
              : test.data.matchedFormats.map((f) => (
                  <Badge key={f.id} tone={f.id === highlightId ? 'ok' : 'info'}>
                    {f.name}
                  </Badge>
                ))}
          </div>
          {highlightId !== undefined ? (
            <div className="muted">
              This format {test.data.matchedFormats.some((f) => f.id === highlightId) ? 'matches' : 'does not match'}.
            </div>
          ) : null}
          {test.data.scores.length ? (
            <ul className="test-result-list">
              {test.data.scores.map((s) => (
                <li key={s.profileId}>
                  {s.profileName}: <strong>{s.score}</strong>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
