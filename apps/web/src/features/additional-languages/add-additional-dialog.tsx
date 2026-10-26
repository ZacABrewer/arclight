import { useEffect, useId, useMemo, useState } from 'react';
import {
  LanguageProfileFlagMode,
  type AdditionalLanguageItemResult,
  type AdditionalLanguageResult,
  type AdditionalLanguageTarget,
} from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Banner, Button, Checkbox, Chip, FormRow, Input, Modal, RadioGroup, Select, Table, Tabs, Toggle, Tooltip, type Column } from '../../arclight/index.js';
import { useAdditionalLanguagePreview, useApplyAdditionalLanguage } from '../../hooks/additional-languages.js';
import { useQualityProfiles } from '../../hooks/library.js';
import { useDebouncedValue } from '../../hooks/metadata.js';
import { t } from '../../i18n/index.js';
import { FLAG_MODE_LABELS, LanguagePicker, useLanguageName } from '../../pages/subtitles/subtitle-ui.js';
import {
  EMPTY_AUDIO,
  EMPTY_SUBTITLE,
  OUTCOME_LABELS,
  OUTCOME_TONE,
  buildRequest,
  outcomeHint,
  subtitleKeyLabel,
  versionTagError,
  type AdditionalTab,
  type AudioDraft,
  type SubtitleDraft,
} from './model.js';
import './additional-languages.css';

// "Add additional…": add an audio or subtitle language to one or more items without losing
// what they have. The preview table shows what will happen per item before anything is saved;
// Confirm saves the languages and starts the searches (a task in Activity / System → Tasks).

const FLAG_OPTIONS = LanguageProfileFlagMode.options.map((m) => ({ value: m, label: FLAG_MODE_LABELS[m] }));

export interface AddAdditionalDialogProps {
  targets: AdditionalLanguageTarget[];
  /** Item name for the dialog title ("Dune (2021)", "3 movies"). */
  title: string;
  open: boolean;
  onClose: () => void;
  initialTab?: AdditionalTab | undefined;
}

export function AddAdditionalDialog({ open, ...rest }: AddAdditionalDialogProps) {
  // Mount only while open so every opening starts from an empty draft.
  return open ? <DialogBody {...rest} /> : null;
}

function DialogBody({ targets, title, onClose, initialTab = 'audio' }: Omit<AddAdditionalDialogProps, 'open'>) {
  const [tab, setTab] = useState<AdditionalTab>(initialTab);
  const [audio, setAudio] = useState<AudioDraft>(EMPTY_AUDIO);
  const [subtitle, setSubtitle] = useState<SubtitleDraft>(EMPTY_SUBTITLE);
  const [result, setResult] = useState<AdditionalLanguageResult | null>(null);
  const apply = useApplyAdditionalLanguage();

  const body = useMemo(() => buildRequest(tab, targets, audio, subtitle), [tab, targets, audio, subtitle]);
  const tagError = tab === 'audio' && audio.mode === 'version' ? versionTagError(audio.versionTag) : null;
  const previewBody = useDebouncedValue(tagError ? null : body, 300);
  const preview = useAdditionalLanguagePreview(result ? null : previewBody);
  const whisperAvailable = preview.data?.whisperAvailable ?? false;

  // Whisper can only be asked for when it is set up.
  useEffect(() => {
    if (preview.data && !preview.data.whisperAvailable && subtitle.useWhisper) setSubtitle((s) => ({ ...s, useWhisper: false }));
  }, [preview.data, subtitle.useWhisper]);

  const confirm = () => {
    if (!body || tagError) return;
    apply.mutate(body, { onSuccess: setResult });
  };

  return (
    <Modal
      open
      size={640}
      onClose={onClose}
      title={t('features.additionalLanguages.dialogTitle', { title })}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={apply.isPending} disabled={!body || tagError !== null} onClick={confirm}>
              {t('features.additionalLanguages.confirm')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <ResultsView result={result} />
      ) : (
        <div className="addl-stack">
          <Tabs
            aria-label={t('features.additionalLanguages.kind')}
            value={tab}
            onChange={(id) => setTab(id as AdditionalTab)}
            tabs={[
              { id: 'audio', label: t('features.additionalLanguages.audioTab'), content: <AudioForm draft={audio} onChange={setAudio} tagError={tagError} /> },
              {
                id: 'subtitle',
                label: t('features.additionalLanguages.subtitleTab'),
                content: <SubtitleForm draft={subtitle} onChange={setSubtitle} whisperAvailable={whisperAvailable} whisperKnown={preview.data !== undefined} />,
              },
            ]}
          />
          <section aria-label={t('features.additionalLanguages.preview')}>
            <div className="al-label">{t('features.additionalLanguages.preview')}</div>
            {!body ? (
              <p className="mk-muted addl-note">{t('features.additionalLanguages.pickToPreview')}</p>
            ) : preview.isError ? (
              <p className="al-inline-error" role="alert">
                {errorMessage(preview.error)}
              </p>
            ) : (
              <ItemTable items={preview.data?.items} loading={preview.isPending || preview.isFetching} kind={tab} />
            )}
          </section>
          {apply.error ? (
            <p className="al-inline-error" role="alert">
              {errorMessage(apply.error)}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function AudioForm({ draft, onChange, tagError }: { draft: AudioDraft; onChange: (d: AudioDraft) => void; tagError: string | null }) {
  const name = useLanguageName();
  const profiles = useQualityProfiles();
  const tagId = useId();
  const profileId = useId();
  const set = (patch: Partial<AudioDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="addl-stack">
      <FormRow label={t('features.additionalLanguages.language')}>
        {draft.language ? (
          <div className="addl-picked">
            <Chip tone="accent">{name(draft.language)}</Chip>
            <Button size="sm" variant="ghost" onClick={() => set({ language: null })}>
              {t('features.additionalLanguages.change')}
            </Button>
          </div>
        ) : (
          <LanguagePicker label={t('features.additionalLanguages.audioLanguage')} onPick={(code) => set({ language: code })} />
        )}
      </FormRow>
      <RadioGroup
        legend={t('features.additionalLanguages.how')}
        value={draft.mode}
        onChange={(mode) => set({ mode })}
        options={[
          { value: 'replace', label: t('features.additionalLanguages.modeReplace'), hint: t('features.additionalLanguages.modeReplaceHint') },
          { value: 'version', label: t('features.additionalLanguages.modeVersion'), hint: t('features.additionalLanguages.modeVersionHint') },
        ]}
      />
      {draft.mode === 'version' ? (
        <>
          <FormRow label={t('features.additionalLanguages.versionName')} htmlFor={tagId} caption={t('features.additionalLanguages.versionNameCaption')} error={tagError ?? undefined}>
            <Input
              id={tagId}
              value={draft.versionTag}
              placeholder={draft.language ? name(draft.language) : ''}
              invalid={tagError !== null}
              onChange={(e) => set({ versionTag: e.currentTarget.value })}
            />
          </FormRow>
          <FormRow label={t('common.qualityProfile')} htmlFor={profileId}>
            <Select
              id={profileId}
              value={draft.qualityProfileId}
              onChange={(e) => set({ qualityProfileId: e.currentTarget.value })}
              options={[{ value: '', label: t('features.additionalLanguages.itemsOwnProfile') }, ...(profiles.data ?? []).map((p) => ({ value: String(p.id), label: p.name }))]}
            />
          </FormRow>
        </>
      ) : null}
      <Banner tone="info">{t('features.additionalLanguages.neverMerged')}</Banner>
    </div>
  );
}

function SubtitleForm({
  draft,
  onChange,
  whisperAvailable,
  whisperKnown,
}: {
  draft: SubtitleDraft;
  onChange: (d: SubtitleDraft) => void;
  whisperAvailable: boolean;
  whisperKnown: boolean;
}) {
  const name = useLanguageName();
  const set = (patch: Partial<SubtitleDraft>) => onChange({ ...draft, ...patch });
  const setItem = (i: number, patch: Partial<SubtitleDraft['languages'][number]>) =>
    set({ languages: draft.languages.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  return (
    <div className="addl-stack">
      <p className="mk-muted addl-note">{t('features.additionalLanguages.subtitleIntro')}</p>
      {draft.languages.length > 0 ? (
        <ul className="addl-langs" aria-label={t('features.additionalLanguages.languagesToAdd')}>
          {draft.languages.map((l, i) => (
            <li key={l.code}>
              <span className="addl-langs__name">
                {name(l.code)} <span className="al-num mk-muted">{l.code}</span>
              </span>
              <span className="addl-langs__flag">{t('common.forced')}</span>
              <Select
                aria-label={t('features.additionalLanguages.forcedFor', { name: name(l.code) })}
                value={l.forced ?? 'never'}
                options={FLAG_OPTIONS}
                onChange={(e) => setItem(i, { forced: e.currentTarget.value as LanguageProfileFlagMode })}
              />
              <span className="addl-langs__flag">{t('common.hi')}</span>
              <Select
                aria-label={t('features.additionalLanguages.hiFor', { name: name(l.code) })}
                value={l.hi ?? 'also'}
                options={FLAG_OPTIONS}
                onChange={(e) => setItem(i, { hi: e.currentTarget.value as LanguageProfileFlagMode })}
              />
              <Button size="sm" variant="ghost" onClick={() => set({ languages: draft.languages.filter((_, j) => j !== i) })}>
                {t('common.remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <LanguagePicker
        label={t('features.additionalLanguages.subtitleLanguage')}
        exclude={draft.languages.map((l) => l.code)}
        onPick={(code) => set({ languages: [...draft.languages, { code, forced: 'never', hi: 'also' }] })}
      />
      <Toggle label={t('features.additionalLanguages.searchNow')} checked={draft.searchNow} onChange={(e) => set({ searchNow: e.currentTarget.checked })} />
      <Checkbox
        label={t('features.additionalLanguages.useWhisper')}
        hint={whisperKnown && !whisperAvailable ? t('features.additionalLanguages.whisperUnavailable') : t('features.additionalLanguages.useWhisperHint')}
        checked={draft.useWhisper}
        disabled={!whisperAvailable || !draft.searchNow}
        onChange={(e) => set({ useWhisper: e.currentTarget.checked })}
      />
    </div>
  );
}

function OutcomeCell({ item }: { item: AdditionalLanguageItemResult }) {
  const hint = outcomeHint(item.outcome);
  return (
    <div className="addl-outcome">
      <Tooltip content={item.message}>
        <span tabIndex={0}>
          <Chip tone={OUTCOME_TONE[item.outcome]}>{OUTCOME_LABELS[item.outcome]}</Chip>
        </span>
      </Tooltip>
      {hint ? <span className="mk-muted addl-outcome__hint">{hint}</span> : null}
    </div>
  );
}

function ItemTable({ items, loading, kind }: { items: AdditionalLanguageItemResult[] | undefined; loading: boolean; kind: AdditionalTab }) {
  const name = useLanguageName();
  const columns: Array<Column<AdditionalLanguageItemResult>> = [
    { key: 'title', header: t('common.title'), cell: (r) => r.title },
    {
      key: 'now',
      header: t('features.additionalLanguages.now'),
      muted: true,
      cell: (r) => {
        const list = kind === 'audio' ? r.currentAudio.map(name) : r.currentSubtitles.map((k) => subtitleKeyLabel(k, name));
        const unknown = kind === 'audio' && r.unanalysedFiles > 0 ? t('features.additionalLanguages.notAnalysed', { count: r.unanalysedFiles }) : null;
        return [list.join(', ') || (unknown ? '' : '—'), unknown].filter(Boolean).join(' · ');
      },
    },
    {
      key: 'outcome',
      header: t('features.additionalLanguages.whatHappens'),
      cell: (r) => (
        <>
          <OutcomeCell item={r} />
          {kind === 'audio' && r.requiredAudio.length > 0 ? (
            <span className="mk-muted addl-outcome__hint">{t('features.additionalLanguages.needs', { languages: r.requiredAudio.map(name).join(' + ') })}</span>
          ) : null}
          {r.versionTag ? <span className="mk-muted addl-outcome__hint">{t('features.additionalLanguages.versionValue', { tag: r.versionTag })}</span> : null}
          {kind === 'subtitle' && r.subtitles.length > 1 ? (
            <ul className="addl-sublist">
              {r.subtitles.map((s) => (
                <li key={`${s.language}:${s.forced}:${s.hi}`}>
                  {subtitleKeyLabel(s.forced ? `${s.language}:forced` : s.hi ? `${s.language}:hi` : s.language, name)}: {OUTCOME_LABELS[s.outcome]}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ),
    },
  ];
  return <Table columns={columns} rows={items} rowKey={(r) => r.key} loading={loading && !items} empty={t('features.additionalLanguages.noItems')} />;
}

function ResultsView({ result }: { result: AdditionalLanguageResult }) {
  return (
    <div className="addl-stack">
      <p className="addl-note">{result.kind === 'audio' ? t('features.additionalLanguages.doneAudio') : t('features.additionalLanguages.doneSubtitle')}</p>
      <ItemTable items={result.items} loading={false} kind={result.kind} />
      {result.jobId !== null ? (
        <p className="mk-muted addl-note">
          {t('features.additionalLanguages.searchesInActivity')}{' '}
          <a className="mk-link" href="/system/tasks">
            {t('common.tasks')}
          </a>
        </p>
      ) : null}
    </div>
  );
}
