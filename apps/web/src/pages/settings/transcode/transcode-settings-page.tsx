import { useId, useState, type ReactNode } from 'react';
import {
  TranscodeAction as TranscodeActionEnum,
  TranscodeHwaccel as TranscodeHwaccelEnum,
  type TranscodeAudioCodec,
  type TranscodeBackendStatus,
  type TranscodeContainer,
  type TranscodeHwaccel,
  type TranscodeMediaType,
  type TranscodeRule,
  type TranscodeVideoCodec,
} from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Banner, Button, Chip, EmptyState, ErrorBlock, FormRow, FormSection, Input, Modal, Segmented, Select, Table, Toggle, type Column } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { TagPicker } from '../../../components/forms/tag-picker.js';
import { MultiSelect } from '../../../components/multi-select.js';
import { useToast } from '../../../components/toast.js';
import { useQualityProfiles } from '../../../hooks/library.js';
import { useDeleteTranscodeRule, useRunTranscode, useSaveTranscodeRule, useTranscodeHwaccel, useTranscodeRules } from '../../../hooks/transcode.js';
import { transcodeQueuedText } from '../../../features/transcode/transcode-now.js';
import { HardwarePane } from './hardware-pane.js';
import { SettingsPage } from '../settings-layout.js';
import { EditorFooter, SaveError } from '../shared.js';
import {
  actionLabel,
  audioChoices,
  hwaccelLabel,
  hwaccelSupports,
  newRuleDraft,
  toRuleBody,
  toRuleDraft,
  visibleOptions,
  whenSummary,
  type HdrChoice,
  type RuleDraft,
  type ScopeKind,
} from './transcode-model.js';
import { t } from '../../../i18n/index.js';

// Settings -> Transcode rules: the rule list (GET /transcoderule) and a 640px editor with the
// scope, `when` conditions, action and the options that action uses. The hwaccel select is fed
// by GET /transcode/hwaccel's capability tests: backends that failed theirs stay selectable only
// when the rule already uses them (with a warning). The Hardware acceleration pane below the
// rules shows every test result.

function mediaTypeLabel(m: TranscodeMediaType): string {
  return m === 'series' ? t('common.series') : m === 'movie' ? t('common.movies') : t('common.all');
}

function TextRow({ label, caption, value, onChange, mono = true, type = 'text', end, placeholder }: {
  label: string;
  caption?: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  type?: string;
  end?: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <FormRow label={label} htmlFor={id} caption={caption}>
      <Input id={id} type={type} mono={mono} end={end} placeholder={placeholder} value={value} onChange={(e) => onChange(e.currentTarget.value)} />
    </FormRow>
  );
}

function SelectRow<V extends string>({ label, caption, value, options, onChange }: {
  label: string;
  caption?: ReactNode;
  value: V;
  options: Array<{ value: V; label: string; disabled?: boolean }>;
  onChange: (v: V) => void;
}) {
  const id = useId();
  return (
    <FormRow label={label} htmlFor={id} caption={caption}>
      <Select id={id} value={value} options={options} onChange={(e) => onChange(e.currentTarget.value as V)} />
    </FormRow>
  );
}

function ToggleRow({ label, caption, checked, onChange }: { label: string; caption?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <FormRow label={label} caption={caption} captionInline>
      <Toggle aria-label={label} checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
    </FormRow>
  );
}

/** Hwaccel options: backends whose test passed; others disabled unless already chosen. */
export function hwaccelOptions(results: readonly TranscodeBackendStatus[] | undefined, current: TranscodeHwaccel) {
  return TranscodeHwaccelEnum.options.map((h) => {
    const available = h === 'none' || results === undefined || results.some((r) => r.backend === h && r.available);
    return {
      value: h,
      label: available ? hwaccelLabel(h) : t('settings.transcode.hwUnavailable', { name: hwaccelLabel(h) }),
      disabled: !available && h !== current,
    };
  });
}

export function RuleEditor({ rule, onClose }: { rule: TranscodeRule | null; onClose: () => void }) {
  const [d, setDraft] = useState<RuleDraft>(() => (rule ? toRuleDraft(rule) : newRuleDraft()));
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useSaveTranscodeRule();
  const remove = useDeleteTranscodeRule();
  const hw = useTranscodeHwaccel();
  const profiles = useQualityProfiles();
  const set = (patch: Partial<RuleDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const shown = new Set(visibleOptions(d.action, d.videoCodec, d.audio));
  const tagsId = useId();
  const selectedHw = shown.has('hwaccel') && d.hwaccel !== 'none' ? hw.data?.results.find((r) => r.backend === d.hwaccel && !r.available) : undefined;

  const submit = () => {
    const result = toRuleBody(d);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    save.mutate({ id: rule?.id, body: result.body }, { onSuccess: onClose });
  };

  return (
    <>
      <Modal
        open
        size={640}
        onClose={onClose}
        title={rule ? t('settings.transcode.editName', { name: rule.name }) : t('settings.transcode.addRule')}
        footer={<EditorFooter onCancel={onClose} onSave={submit} saving={save.isPending} onDelete={rule ? () => setConfirmDelete(true) : undefined} />}
      >
        <form aria-label={t('settings.transcode.ruleForm')} style={{ display: 'flex', flexDirection: 'column', gap: 24 }} onSubmit={(e) => e.preventDefault()} noValidate>
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <FormSection label={t('common.general')}>
            <TextRow label={t('common.name')} mono={false} value={d.name} onChange={(name) => set({ name })} />
            <ToggleRow label={t('common.enabled')} checked={d.enabled} onChange={(enabled) => set({ enabled })} />
            <FormRow label={t('common.mediaType')}>
              <Segmented
                aria-label={t('common.mediaType')}
                value={d.mediaType}
                onChange={(mediaType) => set({ mediaType })}
                options={(['all', 'series', 'movie'] as const).map((m) => ({ value: m, label: mediaTypeLabel(m) }))}
              />
            </FormRow>
            <FormRow label={t('settings.transcode.scope')}>
              <Segmented<ScopeKind>
                aria-label={t('settings.transcode.scope')}
                value={d.scopeKind}
                onChange={(scopeKind) => set({ scopeKind })}
                options={[
                  { value: 'all', label: t('common.all') },
                  { value: 'tags', label: t('common.tags') },
                  { value: 'profiles', label: t('common.profiles') },
                ]}
              />
            </FormRow>
            {d.scopeKind === 'tags' ? (
              <FormRow label={t('common.tags')} htmlFor={tagsId} caption={t('settings.transcode.tagsCaption')}>
                <TagPicker id={tagsId} value={d.tagIds} onChange={(tagIds) => set({ tagIds })} />
              </FormRow>
            ) : null}
            {d.scopeKind === 'profiles' ? (
              <FormRow label={t('common.profiles')} caption={t('settings.transcode.profilesCaption')}>
                <MultiSelect
                  label={t('common.profiles')}
                  options={(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
                  value={d.qualityProfileIds}
                  onChange={(qualityProfileIds) => set({ qualityProfileIds })}
                  emptyLabel={t('common.none')}
                />
              </FormRow>
            ) : null}
          </FormSection>

          <FormSection label={t('settings.transcode.when')}>
            <p className="al-caption" style={{ margin: 0 }}>
              {t('settings.transcode.whenCaption')}
            </p>
            <TextRow label={t('settings.transcode.container')} placeholder="mkv" value={d.container} onChange={(container) => set({ container })} />
            <TextRow label={t('settings.transcode.videoCodec')} placeholder="hevc" value={d.whenVideoCodec} onChange={(whenVideoCodec) => set({ whenVideoCodec })} />
            <TextRow
              label={t('settings.transcode.audioCodec')}
              caption={t('settings.transcode.audioCodecCaption')}
              placeholder="truehd"
              value={d.whenAudioCodec}
              onChange={(whenAudioCodec) => set({ whenAudioCodec })}
            />
            <SelectRow<HdrChoice>
              label={t('settings.transcode.dynamicRange')}
              value={d.hdr}
              onChange={(hdr) => set({ hdr })}
              options={[
                { value: 'any', label: t('settings.transcode.anyRange') },
                { value: 'hdr', label: t('settings.transcode.hdrOnly') },
                { value: 'sdr', label: t('settings.transcode.sdrOnly') },
              ]}
            />
            <TextRow label={t('settings.transcode.resolutionAbove')} type="number" end="px" placeholder="1080" value={d.resolutionAbove} onChange={(resolutionAbove) => set({ resolutionAbove })} />
            <TextRow label={t('settings.transcode.bitrateAbove')} type="number" end="kbit/s" value={d.bitrateAboveKbps} onChange={(bitrateAboveKbps) => set({ bitrateAboveKbps })} />
            <TextRow label={t('settings.transcode.sizeAbove')} type="number" end="GiB" value={d.sizeAboveGb} onChange={(sizeAboveGb) => set({ sizeAboveGb })} />
          </FormSection>

          <FormSection label={t('common.action')}>
            <SelectRow
              label={t('common.action')}
              caption={actionCaption(d.action)}
              value={d.action}
              onChange={(action) => set({ action, ...(action === 'addAudioTrack' && d.audio === 'copy' ? { audio: 'aac' as const } : {}) })}
              options={TranscodeActionEnum.options.map((a) => ({ value: a, label: actionLabel(a) }))}
            />
            <SelectRow<TranscodeContainer>
              label={t('settings.transcode.outputContainer')}
              value={d.outContainer}
              onChange={(outContainer) => set({ outContainer })}
              options={[
                { value: 'mkv', label: 'mkv' },
                { value: 'mp4', label: 'mp4' },
              ]}
            />
            {shown.has('videoCodec') ? (
              <SelectRow<TranscodeVideoCodec>
                label={t('settings.transcode.videoEncoder')}
                value={d.videoCodec}
                onChange={(videoCodec) => set({ videoCodec })}
                options={[
                  { value: 'copy', label: t('settings.transcode.copy') },
                  { value: 'h264', label: 'H.264' },
                  { value: 'hevc', label: 'HEVC' },
                  { value: 'av1', label: 'AV1', disabled: !hwaccelSupports(d.hwaccel, 'av1') },
                ]}
              />
            ) : null}
            {shown.has('hwaccel') ? (
              <SelectRow<TranscodeHwaccel>
                label={t('settings.transcode.hwaccel')}
                caption={
                  hw.data
                    ? hw.data.ffmpegPath
                      ? t('settings.transcode.hwaccelCaption', { path: hw.data.ffmpegPath })
                      : t('settings.transcode.ffmpegNotFound')
                    : undefined
                }
                value={d.hwaccel}
                onChange={(hwaccel) => set({ hwaccel })}
                options={hwaccelOptions(hw.data?.results, d.hwaccel)}
              />
            ) : null}
            {selectedHw ? (
              <Banner tone="warn">{t('settings.transcode.hwSelectedBroken', { name: hwaccelLabel(selectedHw.backend), reason: selectedHw.reason ?? '' })}</Banner>
            ) : null}
            {shown.has('crf') ? (
              <TextRow label={t('settings.transcode.quality')} caption={t('settings.transcode.qualityCaption')} type="number" placeholder="22" value={d.crf} onChange={(crf) => set({ crf })} />
            ) : null}
            {shown.has('preset') ? (
              <TextRow label={t('settings.transcode.preset')} caption={t('settings.transcode.presetCaption')} placeholder="medium" value={d.preset} onChange={(preset) => set({ preset })} />
            ) : null}
            {shown.has('audio') ? (
              <SelectRow<TranscodeAudioCodec>
                label={d.action === 'addAudioTrack' ? t('settings.transcode.extraTrackCodec') : t('settings.transcode.audioEncoder')}
                value={d.audio}
                onChange={(audio) => set({ audio })}
                options={audioChoices(d.action).map((a) => ({ value: a, label: a === 'copy' ? t('settings.transcode.copy') : a.toUpperCase() }))}
              />
            ) : null}
            {shown.has('channels') ? (
              <TextRow
                label={t('settings.transcode.channels')}
                caption={t('settings.transcode.channelsCaption')}
                type="number"
                placeholder={d.action === 'addAudioTrack' ? '2' : ''}
                value={d.channels}
                onChange={(channels) => set({ channels })}
              />
            ) : null}
            <TextRow
              label={t('settings.transcode.keepLanguages')}
              caption={t('settings.transcode.keepLanguagesCaption')}
              placeholder="eng, jpn"
              value={d.keepLanguages}
              onChange={(keepLanguages) => set({ keepLanguages })}
            />
            <ToggleRow label={t('settings.transcode.dropSubtitles')} checked={d.dropSubtitles} onChange={(dropSubtitles) => set({ dropSubtitles })} />
          </FormSection>

          <FormSection label={t('settings.transcode.afterwards')}>
            <ToggleRow label={t('settings.transcode.keepOriginal')} caption={t('settings.transcode.keepOriginalCaption')} checked={d.keepOriginal} onChange={(keepOriginal) => set({ keepOriginal })} />
            <ToggleRow
              label={t('settings.transcode.runAfterImport')}
              caption={t('settings.transcode.runAfterImportCaption')}
              checked={d.runAfterImport}
              onChange={(runAfterImport) => set({ runAfterImport })}
            />
            <ToggleRow
              label={t('settings.transcode.timeWindow')}
              caption={t('settings.transcode.timeWindowCaption')}
              checked={d.windowEnabled}
              onChange={(windowEnabled) => set({ windowEnabled })}
            />
            {d.windowEnabled ? (
              <>
                <TextRow label={t('settings.transcode.windowStart')} type="time" value={d.windowStart} onChange={(windowStart) => set({ windowStart })} />
                <TextRow label={t('settings.transcode.windowEnd')} type="time" value={d.windowEnd} onChange={(windowEnd) => set({ windowEnd })} />
              </>
            ) : null}
          </FormSection>
          <SaveError error={save.error} />
        </form>
      </Modal>
      {rule ? (
        <ConfirmDialog
          open={confirmDelete}
          title={t('settings.transcode.deleteName', { name: rule.name })}
          confirmLabel={t('settings.transcode.deleteRule')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(rule.id);
            onClose();
          }}
        >
          <p>{t('settings.transcode.deleteBody')}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function actionCaption(action: TranscodeRule['action']): string {
  switch (action) {
    case 'remux':
      return t('settings.transcode.remuxCaption');
    case 'transcode':
      return t('settings.transcode.transcodeCaption');
    case 'stripTracks':
      return t('settings.transcode.stripTracksCaption');
    case 'addAudioTrack':
      return t('settings.transcode.addAudioTrackCaption');
  }
}

export function TranscodeSettingsPage() {
  const rules = useTranscodeRules();
  const run = useRunTranscode();
  const toast = useToast();
  const [editing, setEditing] = useState<TranscodeRule | 'new' | null>(null);

  const columns: Column<TranscodeRule>[] = [
    { key: 'name', header: t('common.name'), sortValue: (r) => r.name, cell: (r) => r.name },
    {
      key: 'enabled',
      header: t('common.status'),
      cell: (r) => <Chip tone={r.enabled ? 'accent' : 'muted'}>{r.enabled ? t('common.enabled') : t('common.disabled')}</Chip>,
    },
    { key: 'mediaType', header: t('common.mediaType'), muted: true, cell: (r) => mediaTypeLabel(r.mediaType) },
    { key: 'when', header: t('settings.transcode.when'), mono: true, cell: (r) => whenSummary(r.when) },
    { key: 'action', header: t('common.action'), cell: (r) => actionLabel(r.action) },
    { key: 'window', header: t('settings.transcode.window'), mono: true, cell: (r) => (r.schedule ? `${r.schedule.start}–${r.schedule.end}` : t('settings.transcode.anyTime')) },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (r) => (
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <Button
            size="sm"
            variant="secondary"
            disabled={!r.enabled}
            loading={run.isPending && run.variables?.ruleId === r.id}
            aria-label={t('settings.transcode.runName', { name: r.name })}
            onClick={() => run.mutate({ ruleId: r.id }, { onSuccess: (res) => toast.push({ tone: 'ok', title: transcodeQueuedText(res), message: r.name }) })}
          >
            {t('settings.transcode.run')}
          </Button>
          <Button size="sm" variant="ghost" aria-label={t('settings.transcode.editName', { name: r.name })} onClick={() => setEditing(r)}>
            {t('common.edit')}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <SettingsPage
      title={t('settings.transcode.title')}
      description={t('settings.transcode.description')}
      after={<HardwarePane rules={rules.data} />}
      actions={
        <Button variant="primary" onClick={() => setEditing('new')}>
          {t('settings.transcode.addRule')}
        </Button>
      }
    >
      {rules.isError ? (
        <ErrorBlock title={t('settings.transcode.couldNotLoad')} onRetry={() => void rules.refetch()}>
          {errorMessage(rules.error)}
        </ErrorBlock>
      ) : (
        <Table
          caption={t('settings.transcode.title')}
          columns={columns}
          rows={rules.data}
          rowKey={(r) => r.id}
          loading={rules.isPending}
          density="dense"
          empty={<EmptyState title={t('settings.transcode.empty')}>{t('settings.transcode.emptyBody')}</EmptyState>}
        />
      )}
      {editing ? <RuleEditor rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </SettingsPage>
  );
}
