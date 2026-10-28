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
import { useFeatures } from '../../../hooks/music.js';
import { customFormatDomain } from '../../../lib/custom-format-domain.js';
import { domainLabel } from '../profiles/quality-profile-model.js';
import './custom-formats.css';
import { t } from '../../../i18n/index.js';

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
      setParseError(t('settings.customFormats.notValidJsonErrormessage', { errorMessage: errorMessage(err) }));
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
    if (failures.length) toast.error(t('settings.customFormats.importedCreatedFailurescountFailed', { created, failuresCount: failures.length }), failures.join('; '));
    else toast.push({ tone: 'ok', title: t('settings.customFormats.importedCreatedCustomFormats', { created }) });
    onClose();
  };

  const count = result?.formats.length ?? 0;

  return (
    <Modal
      open
      size={640}
      onClose={onClose}
      title={t('settings.customFormats.importCustomFormats')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {count === 1 ? <Button onClick={() => onEditSingle(result!.formats[0]!)}>{t('settings.customFormats.reviewInEditor')}</Button> : null}
          <Button variant="primary" loading={busy} disabled={count === 0} onClick={() => void importAll()}>
            {count === 1 ? t('settings.customFormats.importFormat') : t('settings.customFormats.importCountFormats', { count })}
          </Button>
        </>
      }
    >
      <div className="al-cf-import">
        <Field label={t('settings.customFormats.sourceApp')} hint={t('settings.customFormats.numericValuesSourcesFlagsDiffer')}>
          <Select
            value={app}
            onChange={(e) => {
              const next = e.currentTarget.value === 'radarr' ? 'radarr' : 'sonarr';
              setApp(next);
              parse(text, next);
            }}
            options={[
              { value: 'sonarr', label: t('settings.customFormats.sonarrTrashSeries') },
              { value: 'radarr', label: t('settings.customFormats.radarrTrashMovies') },
            ]}
          />
        </Field>
        <Field label={t('settings.customFormats.jsonFile')}>
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
        <Field label={t('settings.customFormats.orPasteJson')} error={parseError ?? undefined}>
          <Textarea
            mono
            rows={10}
            value={text}
            spellCheck={false}
            placeholder={t('settings.customFormats.nameIncludecustomformatwhenrenamingFalseSpecific')}
            onChange={(e) => parse(e.currentTarget.value, app)}
          />
        </Field>
        {result ? (
          <div className="al-cf-import__result" role="status">
            <span className="al-cf-import__count">
              <span className="al-num">{count}</span> {t('settings.customFormats.formatsReady', { count })}
            </span>
            <span className="al-chip-row">
              {result.formats.map((f) => (
                <Tag key={f.name}>
                  {f.name} · <span className="al-num">{f.specifications.length}</span> {t('settings.customFormats.conditions', { specificationsCount: f.specifications.length })}
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

export function CustomFormatCard({
  format,
  profiles,
  onEdit,
  showDomain = false,
}: {
  format: CustomFormat;
  profiles: readonly QualityProfile[];
  onEdit: () => void;
  /** Label the format with its media domain (video / music / audiobook / any). */
  showDomain?: boolean;
}) {
  const scores = profileScores(format, profiles);
  const domain = customFormatDomain(format);
  return (
    <ItemCard
      title={format.name}
      onClick={onEdit}
      status={
        format.includeWhenRenaming || showDomain ? (
          <span className="al-chip-row">
            {showDomain ? (
              <Chip tone={domain === 'any' ? 'muted' : 'neutral'} dot="none" data-testid="format-domain" data-domain={domain}>
                {domainLabel(domain)}
              </Chip>
            ) : null}
            {format.includeWhenRenaming ? (
              <Chip tone="neutral" dot="none">
                {t('settings.customFormats.renaming')}
              </Chip>
            ) : null}
          </span>
        ) : null
      }
    >
      <span className="al-cf-card__row" aria-label={t('settings.customFormats.conditionsInName', { name: format.name })}>
        {format.specifications.length === 0 ? <span className="al-muted">{t('settings.customFormats.noConditions')}</span> : null}
        {format.specifications.map((s, i) => (
          <Tag key={i} className="al-cf-cond" data-negate={s.negate || undefined} data-required={s.required || undefined}>
            {s.negate ? t('settings.customFormats.not') : ''}
            {s.name}
            {s.required ? <span className="al-cf-cond__req"> {t('settings.customFormats.required')}</span> : null}
          </Tag>
        ))}
      </span>
      {scores.length ? (
        <span className="al-cf-card__row" aria-label={t('settings.customFormats.scoresForName', { name: format.name })}>
          {scores.map((s) => (
            <ScoreTag key={s.profile} name={s.profile} score={s.score} />
          ))}
        </span>
      ) : (
        <span className="al-caption">{t('settings.customFormats.notScoredInAnyProfile')}</span>
      )}
    </ItemCard>
  );
}

export function CustomFormatsPage() {
  const list = useCustomFormatList();
  const schema = useCustomFormatSchema();
  const profiles = useQualityProfileList();
  const features = useFeatures();
  const [editing, setEditing] = useState<CustomFormat | 'new' | null>(null);
  const [prefill, setPrefill] = useState<CustomFormatInput | undefined>();
  const [importing, setImporting] = useState(false);

  const addNew = () => {
    setPrefill(undefined);
    setEditing('new');
  };

  return (
    <SettingsPage
      title={t('settings.customFormats.customFormats')}
      description={t('settings.customFormats.scoreReleasesByWhatTheir')}
      actions={
        <>
          <Button size="sm" onClick={() => setImporting(true)}>
            {t('common.import')}
          </Button>
          <Button size="sm" disabled={!list.data?.length} onClick={() => download('custom-formats.json', (list.data ?? []).map(exportCustomFormat))}>
            {t('settings.customFormats.exportAll')}
          </Button>
        </>
      }
    >
      <SettingsSection
        label={t('common.formats')}
        {...(list.data ? { count: list.data.length } : {})}
        action={
          <Button size="sm" variant="secondary" onClick={addNew} disabled={!schema.data}>
            {t('settings.customFormats.addCustomFormat')}
          </Button>
        }
      >
        {list.isPending ? (
          <Skeleton lines={3} />
        ) : list.isError ? (
          <ErrorBlock title={t('settings.customFormats.couldntLoadCustomFormats')} onRetry={() => void list.refetch()}>
            {errorMessage(list.error)}
          </ErrorBlock>
        ) : (
          <CardGrid label={t('settings.customFormats.customFormats')}>
            {list.data.map((cf) => (
              <CustomFormatCard key={cf.id} format={cf} profiles={profiles.data ?? []} onEdit={() => setEditing(cf)} showDomain={features.music || features.audiobooks} />
            ))}
            <AddCard label={t('settings.customFormats.addCustomFormat')} onClick={addNew} />
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
