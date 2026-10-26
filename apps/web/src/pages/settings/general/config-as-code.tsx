import { useId, useState, type ChangeEvent } from 'react';
import type { ConfigChange, ConfigImportResult, ConfigManagedKeys } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { configApi, configExportUrl, configFileName, downloadText, type ConfigFormat } from '../../../api/config.js';
import { Button, Checkbox, Chip, FormRow, KeyValue, LinkButton, Modal, Segmented, Table, Textarea, Toggle, type ChipTone, type Column } from '../../../arclight/index.js';
import { useConfigImport, useManagedKeys } from '../../../hooks/config.js';
import { useMetricsSettings, useSaveMetricsSettings } from '../../../hooks/audit.js';
import { formatDateTime } from '../../../lib/format.js';
import { SettingsSection } from '../shared.js';
import './config-as-code.css';
import { t } from '../../../i18n/index.js';

// Settings → General → Config as code: export the whole configuration, import a document with a
// dry-run diff first, and show what the config file / env variables own.

const OP_TONE: Record<ConfigChange['op'], ChipTone> = { create: 'accent', update: 'default', delete: 'danger' };
const OP_LABEL: Record<ConfigChange['op'], string> = { get create() { return t('settings.general.configAsCode.create'); }, get update() { return t('settings.general.configAsCode.update'); }, get delete() { return t('common.delete'); } };

/** "2 to create · 1 to update · 0 to delete · 14 unchanged". */
export function importSummaryText(result: Pick<ConfigImportResult, 'summary'>): string {
  const s = result.summary;
  return t('settings.general.configAsCode.createToCreateUpdateTo', { create: s.create, update: s.update, delete: s.delete, unchanged: s.unchanged });
}

/** An apply is allowed once a dry run came back with changes and no errors. */
export function canApply(result: ConfigImportResult | null): boolean {
  return !!result && result.dryRun && result.errors.length === 0 && result.changes.length > 0;
}

/** Changed field paths of an update ("port, settings.host"), or "—". */
export function changeFields(change: ConfigChange): string {
  return change.fields?.length ? change.fields.map((f) => f.path).join(', ') : '—';
}

/** Number of managed settings keys plus resource keys. */
export function managedCount(keys: ConfigManagedKeys | undefined): number {
  if (!keys) return 0;
  const count = (rec: Record<string, string[]>) => Object.values(rec).reduce((n, list) => n + list.length, 0);
  return count(keys.settings) + count(keys.resources);
}

function ExportBlock() {
  const ids = { format: useId() };
  const [format, setFormat] = useState<ConfigFormat>('yaml');
  const [secrets, setSecrets] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportWithSecrets = async () => {
    setBusy(true);
    setError(null);
    try {
      const text = await configApi.exportText(format, true);
      downloadText(text, configFileName(format), format === 'yaml' ? 'application/yaml' : 'application/json');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <FormRow label={t('settings.general.configAsCode.export')} htmlFor={ids.format} caption={t('settings.general.configAsCode.everySettingsSectionAndResource')}>
        <div className="al-cac__row">
          <Segmented
            aria-label={t('settings.general.configAsCode.exportFormat')}
            variant="soft"
            value={format}
            onChange={setFormat}
            options={[
              { value: 'yaml', label: t('settings.general.configAsCode.yaml') },
              { value: 'json', label: t('settings.general.configAsCode.json') },
            ]}
          />
          <Checkbox
            label={t('settings.general.configAsCode.includeSecrets')}
            checked={secrets}
            onChange={(e) => {
              if (e.currentTarget.checked) setConfirming(true);
              else setSecrets(false);
            }}
          />
          {secrets ? (
            <Button variant="secondary" loading={busy} onClick={() => void exportWithSecrets()}>
              {t('settings.general.configAsCode.exportConfig')}
            </Button>
          ) : (
            <LinkButton variant="secondary" href={configExportUrl(format, false)} download={configFileName(format)}>
              {t('settings.general.configAsCode.exportConfig')}
            </LinkButton>
          )}
        </div>
      </FormRow>
      {error ? (
        <p className="al-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('settings.general.configAsCode.includeSecretsInTheExport')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setSecrets(true);
                setConfirming(false);
              }}
            >
              {t('settings.general.configAsCode.includeSecrets')}
            </Button>
          </>
        }
      >
        <p>{t('settings.general.configAsCode.theFileWillContainApi')}</p>
      </Modal>
    </>
  );
}

function ImportBlock() {
  const ids = { file: useId(), text: useId(), prune: useId() };
  const [content, setContent] = useState('');
  const [prune, setPrune] = useState(false);
  const [preview, setPreview] = useState<ConfigImportResult | null>(null);
  const [applied, setApplied] = useState<ConfigImportResult | null>(null);
  const run = useConfigImport();

  const reset = () => {
    setPreview(null);
    setApplied(null);
    run.reset();
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    setContent(await file.text());
    reset();
  };

  const dryRun = () => {
    setApplied(null);
    run.mutate({ content, dryRun: true, prune }, { onSuccess: setPreview });
  };
  const apply = () => run.mutate({ content, dryRun: false, prune }, { onSuccess: (r) => (r.applied ? (setApplied(r), setPreview(null)) : setPreview(r)) });

  const columns: Column<ConfigChange>[] = [
    { key: 'kind', header: t('settings.general.configAsCode.kind'), mono: true, cell: (c) => c.kind },
    { key: 'key', header: t('settings.general.configAsCode.key'), mono: true, cell: (c) => c.key },
    { key: 'op', header: t('settings.general.configAsCode.change'), cell: (c) => <Chip tone={OP_TONE[c.op]}>{OP_LABEL[c.op]}</Chip> },
    { key: 'fields', header: t('settings.general.configAsCode.fields'), mono: true, muted: true, cell: changeFields },
  ];

  return (
    <>
      <FormRow label={t('settings.general.configAsCode.importFile')} htmlFor={ids.file} caption={t('settings.general.configAsCode.aYamlOrJsonDocument')}>
        <input id={ids.file} type="file" accept=".yml,.yaml,.json,application/json,application/yaml,text/yaml" className="al-cac__file" onChange={(e) => void onFile(e)} />
      </FormRow>
      <FormRow label={t('settings.general.configAsCode.orPaste')} htmlFor={ids.text}>
        <Textarea
          id={ids.text}
          mono
          rows={8}
          spellCheck={false}
          placeholder={t('settings.general.configAsCode.version1SettingsMetadataLanguage')}
          value={content}
          onChange={(e) => {
            setContent(e.currentTarget.value);
            reset();
          }}
        />
      </FormRow>
      <FormRow label={t('settings.general.configAsCode.prune')} htmlFor={ids.prune} caption={t('settings.general.configAsCode.deleteResourcesMissingFromThe')} captionInline>
        <Toggle
          id={ids.prune}
          checked={prune}
          label={t('settings.general.configAsCode.deleteWhatTheDocumentDoes')}
          onChange={(e) => {
            setPrune(e.currentTarget.checked);
            reset();
          }}
        />
      </FormRow>
      <div className="al-cac__actions">
        <Button variant="secondary" disabled={!content.trim()} loading={run.isPending && run.variables?.dryRun === true} onClick={dryRun}>
          {t('settings.general.configAsCode.previewChanges')}
        </Button>
        <Button variant="primary" disabled={!canApply(preview) || run.isPending} loading={run.isPending && run.variables?.dryRun === false} onClick={apply}>
          {t('settings.general.configAsCode.applyChanges')}
        </Button>
      </div>
      {run.isError ? (
        <p className="al-inline-error" role="alert">
          {errorMessage(run.error)}
        </p>
      ) : null}
      {applied ? (
        <p className="al-cac__done" role="status">
          {t('settings.general.configAsCode.appliedImportsummarytext', { importSummaryText: importSummaryText(applied) })}
        </p>
      ) : null}
      {preview ? (
        <div className="al-cac__preview" role="region" aria-label={t('settings.general.configAsCode.importPreview')}>
          <p className="al-cac__summary al-num">{importSummaryText(preview)}</p>
          {preview.errors.length ? (
            <ul className="al-cac__issues" data-tone="danger" aria-label={t('settings.general.configAsCode.errors')}>
              {preview.errors.map((e) => (
                <li key={`${e.path}:${e.message}`}>
                  <code className="al-num">{e.path || t('settings.general.configAsCode.document')}</code> {e.message}
                </li>
              ))}
            </ul>
          ) : null}
          {preview.warnings.length ? (
            <ul className="al-cac__issues" data-tone="warn" aria-label={t('common.warnings')}>
              {preview.warnings.map((w) => (
                <li key={`${w.path}:${w.message}`}>
                  <code className="al-num">{w.path || t('settings.general.configAsCode.document')}</code> {w.message}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="al-cac__table">
            <Table caption={t('settings.general.configAsCode.changes')} columns={columns} rows={preview.changes} rowKey={(c) => `${c.kind}:${c.key}:${c.op}`} density="dense" empty={<p className="al-caption">{t('settings.general.configAsCode.nothingToChangeTheDocument')}</p>} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function ManagedBlock() {
  const keys = useManagedKeys();
  if (!keys.data || (!keys.data.file && keys.data.env.length === 0 && keys.data.errors.length === 0)) {
    return (
      <FormRow label={t('settings.general.configAsCode.managedFile')} caption={t('settings.general.configAsCode.setArclightConfigFileTo')}>
        <span className="al-caption">{t('settings.general.configAsCode.notInUse')}</span>
      </FormRow>
    );
  }
  const k = keys.data;
  return (
    <FormRow label={t('settings.general.configAsCode.managedFile')} caption={t('settings.general.configAsCode.sectionsAndResourcesListedIn')}>
      <div className="al-cac__managed">
        <KeyValue
          items={[
            { label: t('common.file'), value: k.file ?? '—' },
            { label: t('common.applied'), value: k.appliedAt ? formatDateTime(k.appliedAt) : '—' },
            { label: t('settings.general.configAsCode.managedKeys'), value: String(managedCount(k)) },
            { label: t('settings.general.configAsCode.envOverrides'), value: k.env.length ? k.env.join(', ') : 'none' },
          ]}
        />
        {k.errors.length ? (
          <ul className="al-cac__issues" data-tone="danger" aria-label={t('settings.general.configAsCode.configFileErrors')}>
            {k.errors.map((e) => (
              <li key={`${e.path}:${e.message}`}>
                <code className="al-num">{e.path || t('settings.general.configAsCode.file')}</code> {e.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </FormRow>
  );
}

function MetricsRow() {
  const id = useId();
  const metrics = useMetricsSettings();
  const save = useSaveMetricsSettings();
  return (
    <FormRow label={t('settings.general.configAsCode.metrics')} htmlFor={id} caption={t('settings.general.configAsCode.prometheusScrapesMetricsWithThe')} captionInline>
      <Toggle
        id={id}
        label={t('settings.general.configAsCode.allowMetricsWithoutCredentials')}
        disabled={!metrics.data || save.isPending}
        checked={metrics.data?.allowAnonymous ?? false}
        onChange={(e) => save.mutate({ allowAnonymous: e.currentTarget.checked })}
      />
    </FormRow>
  );
}

/** The "Config as code" and "Monitoring" sections of Settings → General. */
export function ConfigAsCodeSection() {
  return (
    <>
      <SettingsSection label={t('settings.general.configAsCode.configAsCode')}>
        <div className="al-cac">
          <ExportBlock />
          <ImportBlock />
          <ManagedBlock />
        </div>
      </SettingsSection>
      <SettingsSection label={t('settings.general.configAsCode.monitoring')}>
        <MetricsRow />
      </SettingsSection>
    </>
  );
}
