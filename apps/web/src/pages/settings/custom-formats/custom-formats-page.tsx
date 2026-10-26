import { useState } from 'react';
import type { CustomFormat, CustomFormatInput } from '@media-tron/shared';
import { profilesApi } from '../../../api/profiles.js';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { FormField, Select } from '../../../components/form.js';
import { Modal } from '../../../components/modal.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useToast } from '../../../components/toast.js';
import { useCustomFormatList, useCustomFormatSchema } from '../../../hooks/profiles.js';
import { useQueryClient } from '@tanstack/react-query';
import { settingsKeys } from '../../../hooks/settings-keys.js';
import { errorMessage } from '../../../api/client.js';
import { AddCard, CardGrid, ItemCard } from '../shared.js';
import { CustomFormatEditor } from './custom-format-editor.js';
import { exportCustomFormat, parseCustomFormatJson, type ImportResult, type SourceApp } from './custom-format-json.js';

function download(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function ImportDialog({ onClose, onEditSingle }: { onClose: () => void; onEditSingle: (f: CustomFormatInput) => void }) {
  const [text, setText] = useState('');
  const [app, setApp] = useState<SourceApp>('sonarr');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();

  const parse = (value: string, source: SourceApp) => {
    setText(value);
    if (!value.trim()) return setResult(null);
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

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title="Import custom formats"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {result?.formats.length === 1 ? (
            <Button onClick={() => onEditSingle(result.formats[0]!)}>Review in editor</Button>
          ) : null}
          <Button variant="primary" loading={busy} disabled={!result?.formats.length} onClick={() => void importAll()}>
            Import {result?.formats.length ?? 0}
          </Button>
        </>
      }
    >
      <FormField label="Source app" hint="Numeric values (sources, flags) differ between Sonarr and Radarr exports.">
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
      </FormField>
      <FormField label="JSON file">
        <input
          type="file"
          accept="application/json,.json"
          onChange={async (e) => {
            const file = e.currentTarget.files?.[0];
            if (file) parse(await file.text(), app);
          }}
        />
      </FormField>
      <FormField label="…or paste JSON" error={parseError ?? undefined}>
        <textarea
          className="input textarea input-mono"
          rows={10}
          value={text}
          placeholder='{"name": "…", "includeCustomFormatWhenRenaming": false, "specifications": [ … ]}'
          onChange={(e) => parse(e.currentTarget.value, app)}
        />
      </FormField>
      {result ? (
        <div className="test-result">
          <strong>
            {result.formats.length} format{result.formats.length === 1 ? '' : 's'} ready:
          </strong>{' '}
          {result.formats.map((f) => `${f.name} (${f.specifications.length} conditions)`).join(', ') || 'none'}
          {result.warnings.length ? (
            <ul className="test-result-list test-result-warnings">
              {result.warnings.map((w) => (
                <li key={w}>⚠ {w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

export function CustomFormatsPage() {
  const list = useCustomFormatList();
  const schema = useCustomFormatSchema();
  const [editing, setEditing] = useState<CustomFormat | 'new' | null>(null);
  const [prefill, setPrefill] = useState<CustomFormatInput | undefined>();
  const [importing, setImporting] = useState(false);

  return (
    <Page
      title="Custom Formats"
      actions={
        <>
          <Button onClick={() => setImporting(true)}>Import</Button>
          <Button
            disabled={!list.data?.length}
            onClick={() => download('custom-formats.json', (list.data ?? []).map(exportCustomFormat))}
          >
            Export all
          </Button>
        </>
      }
    >
      <Card>
        {list.isPending ? (
          <LoadingBlock />
        ) : list.isError ? (
          <ErrorView error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <CardGrid>
            {list.data.map((cf) => (
              <ItemCard key={cf.id} title={cf.name} onClick={() => setEditing(cf)}>
                <div className="badge-row">
                  {cf.specifications.map((s, i) => (
                    <Badge key={i} tone={s.required ? 'info' : s.negate ? 'warning' : 'neutral'}>
                      {s.negate ? 'not ' : ''}
                      {s.name}
                    </Badge>
                  ))}
                </div>
              </ItemCard>
            ))}
            <AddCard
              label="Add custom format"
              onClick={() => {
                setPrefill(undefined);
                setEditing('new');
              }}
            />
          </CardGrid>
        )}
      </Card>
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
    </Page>
  );
}
