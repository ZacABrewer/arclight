import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CustomFormat, CustomFormatInput, QualityProfile } from '@arclight/shared';
import { profilesApi } from '../../../api/profiles.js';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, Field, Modal, ScoreTag, Select, Skeleton, Tag, Textarea } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useCustomFormatList, useCustomFormatSchema, useQualityProfileList } from '../../../hooks/profiles.js';
import { settingsKeys } from '../../../hooks/settings-keys.js';
import { SettingsPage } from '../settings-layout.js';
import { AddCard, CardGrid, ItemCard, SettingsSection } from '../shared.js';
import { CustomFormatEditor } from './custom-format-editor.js';
import { exportCustomFormat, parseCustomFormatJson, type ImportResult, type SourceApp } from './custom-format-json.js';
import './custom-formats.css';

function download(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ImportDialog({ onClose, onEditSingle }: { onClose: () => void; onEditSingle: (f: CustomFormatInput) => void }) {
  const [text, setText] = useState('');
  const [app, setApp] = useState<SourceApp>('sonarr');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const fileId = useId();

  const parse = (value: string, source: SourceApp) => {
    setText(value);
    if (!value.trim()) {
      setParseError(null);
      return setResult(null);
    }
    try {
      setResult(parseCustomFormatJson(value, source));
      setParseError(null);
    } catch (err) {
      setResult(null);
      setParseError(`Not valid JSON: ${errorMessage(err)}`);
    }
  };

  const importAll = async () => {
    if (!result) return;
    setBusy(true);
    let created = 0;
    const failures: string[] = [];
    for (const f of result.formats) {
      try {
        await profilesApi.customFormats.create(f);
        created++;
      } catch (err) {
        failures.push(`${f.name}: ${errorMessage(err)}`);
      }
    }
    setBusy(false);
    await qc.invalidateQueries({ queryKey: settingsKeys.customFormats });
    if (failures.length) toast.error(`Imported ${created}, ${failures.length} failed`, failures.join('; '));
    else toast.push({ tone: 'ok', title: `Imported ${created} custom format${created === 1 ? '' : 's'}` });
    onClose();
  };

  const count = result?.formats.length ?? 0;

  return (
    <Modal
      open
      size={640}
      onClose={onClose}
      title="Import custom formats"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {count === 1 ? <Button onClick={() => onEditSingle(result!.formats[0]!)}>Review in editor</Button> : null}
          <Button variant="primary" loading={busy} disabled={count === 0} onClick={() => void importAll()}>
            {count === 1 ? 'Import format' : `Import ${count} formats`}
          </Button>
        </>
      }
    >
      <div className="al-cf-import">
        <Field label="Source app" hint="Numeric values (sources, flags) differ between Sonarr and Radarr exports.">
          <Select
            value={app}
            onChange={(e) => {
              const next = e.currentTarget.value === 'radarr' ? 'radarr' : 'sonarr';
              setApp(next);
              parse(text, next);
            }}
            options={[
              { value: 'sonarr', label: 'Sonarr / TRaSH (series)' },
              { value: 'radarr', label: 'Radarr / TRaSH (movies)' },
            ]}
          />
        </Field>
        <Field label="JSON file">
          <input
            id={fileId}
            className="al-cf-import__file"
            type="file"
            accept="application/json,.json"
            onChange={async (e) => {
              const file = e.currentTarget.files?.[0];
              if (file) parse(await file.text(), app);
            }}
          />
        </Field>
        <Field label="Or paste JSON" error={parseError ?? undefined}>
          <Textarea
            mono
            rows={10}
            value={text}
            spellCheck={false}
            placeholder='{"name": "…", "includeCustomFormatWhenRenaming": false, "specifications": [ … ]}'
            onChange={(e) => parse(e.currentTarget.value, app)}
          />
        </Field>
        {result ? (
          <div className="al-cf-import__result" role="status">
            <span className="al-cf-import__count">
              <span className="al-num">{count}</span> {count === 1 ? 'format' : 'formats'} ready
            </span>
            <span className="al-chip-row">
              {result.formats.map((f) => (
                <Tag key={f.name}>
                  {f.name} · <span className="al-num">{f.specifications.length}</span> {f.specifications.length === 1 ? 'condition' : 'conditions'}
                </Tag>
              ))}
            </span>
            {result.warnings.length ? (
              <ul className="al-cf-import__warnings">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/** Scores a format carries in each quality profile (zero scores are left out). */
export function profileScores(format: CustomFormat, profiles: readonly QualityProfile[]): Array<{ profile: string; score: number }> {
  return profiles.flatMap((p) => {
    const score = p.formatItems.find((i) => i.formatId === format.id)?.score ?? 0;
    return score === 0 ? [] : [{ profile: p.name, score }];
  });
}

export function CustomFormatCard({ format, profiles, onEdit }: { format: CustomFormat; profiles: readonly QualityProfile[]; onEdit: () => void }) {
  const scores = profileScores(format, profiles);
  return (
    <ItemCard
      title={format.name}
      onClick={onEdit}
      status={
        format.includeWhenRenaming ? (
          <Chip tone="neutral" dot="none">
            Renaming
          </Chip>
        ) : null
      }
    >
      <span className="al-cf-card__row" aria-label={`Conditions in ${format.name}`}>
        {format.specifications.length === 0 ? <span className="al-muted">No conditions</span> : null}
        {format.specifications.map((s, i) => (
          <Tag key={i} className="al-cf-cond" data-negate={s.negate || undefined} data-required={s.required || undefined}>
            {s.negate ? 'not ' : ''}
            {s.name}
            {s.required ? <span className="al-cf-cond__req"> · required</span> : null}
          </Tag>
        ))}
      </span>
      {scores.length ? (
        <span className="al-cf-card__row" aria-label={`Scores for ${format.name}`}>
          {scores.map((s) => (
            <ScoreTag key={s.profile} name={s.profile} score={s.score} />
          ))}
        </span>
      ) : (
        <span className="al-caption">Not scored in any profile</span>
      )}
    </ItemCard>
  );
}

export function CustomFormatsPage() {
  const list = useCustomFormatList();
  const schema = useCustomFormatSchema();
  const profiles = useQualityProfileList();
  const [editing, setEditing] = useState<CustomFormat | 'new' | null>(null);
  const [prefill, setPrefill] = useState<CustomFormatInput | undefined>();
  const [importing, setImporting] = useState(false);

  const addNew = () => {
    setPrefill(undefined);
    setEditing('new');
  };

  return (
    <SettingsPage
      title="Custom formats"
      description="Score releases by what their title and files say. Each quality profile sets how much a format is worth."
      actions={
        <>
          <Button size="sm" onClick={() => setImporting(true)}>
            Import
          </Button>
          <Button size="sm" disabled={!list.data?.length} onClick={() => download('custom-formats.json', (list.data ?? []).map(exportCustomFormat))}>
            Export all
          </Button>
        </>
      }
    >
      <SettingsSection
        label="Formats"
        {...(list.data ? { count: list.data.length } : {})}
        action={
          <Button size="sm" variant="secondary" onClick={addNew} disabled={!schema.data}>
            Add custom format
          </Button>
        }
      >
        {list.isPending ? (
          <Skeleton lines={3} />
        ) : list.isError ? (
          <ErrorBlock title="Couldn't load custom formats" onRetry={() => void list.refetch()}>
            {errorMessage(list.error)}
          </ErrorBlock>
        ) : (
          <CardGrid label="Custom formats">
            {list.data.map((cf) => (
              <CustomFormatCard key={cf.id} format={cf} profiles={profiles.data ?? []} onEdit={() => setEditing(cf)} />
            ))}
            <AddCard label="Add custom format" onClick={addNew} />
          </CardGrid>
        )}
      </SettingsSection>
      {editing && schema.data ? (
        <CustomFormatEditor
          key={editing === 'new' ? 'new' : editing.id}
          format={editing === 'new' ? null : editing}
          initial={prefill}
          schema={schema.data}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {importing ? (
        <ImportDialog
          onClose={() => setImporting(false)}
          onEditSingle={(f) => {
            setImporting(false);
            setPrefill(f);
            setEditing('new');
          }}
        />
      ) : null}
    </SettingsPage>
  );
}
