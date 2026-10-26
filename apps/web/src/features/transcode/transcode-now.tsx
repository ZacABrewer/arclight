import { useId, useState } from 'react';
import type { TranscodeRule, TranscodeRunRequest, TranscodeRunResult } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Banner, Button, FormRow, Modal, Select } from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { useToast } from '../../components/toast.js';
import { useRunTranscode, useTranscodeRules } from '../../hooks/transcode.js';
import { t } from '../../i18n/index.js';

// "Transcode now" for one library file. The contract's POST /transcode/run takes exactly one of
// `mediaFileId` (the first enabled rule matching that file, started at once) or `ruleId` (every
// matching file of the library, inside the rule's window). There is no "this file with that
// rule", so picking a specific rule runs it over the library and the dialog says so.

/** '' = first matching enabled rule for this file; otherwise a rule id. */
export type TranscodeChoice = '' | `${number}`;

export function transcodeRunBody(mediaFileId: number, choice: TranscodeChoice): TranscodeRunRequest {
  return choice === '' ? { mediaFileId } : { ruleId: Number(choice) };
}

export function transcodeQueuedText(r: TranscodeRunResult): string {
  return t('features.transcode.queuedJobs', { count: r.queued });
}

export function ruleOptions(rules: readonly TranscodeRule[] | undefined) {
  return [
    { value: '', label: t('features.transcode.firstMatchingRule') },
    ...(rules ?? []).filter((r) => r.enabled).map((r) => ({ value: String(r.id), label: r.name })),
  ];
}

export function TranscodeNowDialog({ mediaFileId, fileLabel, onClose }: { mediaFileId: number; fileLabel: string; onClose: () => void }) {
  const rules = useTranscodeRules();
  const run = useRunTranscode({ silent: true });
  const toast = useToast();
  const [choice, setChoice] = useState<TranscodeChoice>('');
  const selectId = useId();
  const enabled = (rules.data ?? []).filter((r) => r.enabled);

  const submit = () =>
    run.mutate(transcodeRunBody(mediaFileId, choice), {
      onSuccess: (r) => {
        toast.push({ tone: r.queued > 0 ? 'ok' : 'info', title: transcodeQueuedText(r), message: fileLabel });
        onClose();
      },
    });

  return (
    <Modal
      open
      size={560}
      onClose={onClose}
      title={t('features.transcode.transcodeNow')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={run.isPending} disabled={rules.isSuccess && enabled.length === 0} onClick={submit}>
            {choice === '' ? t('features.transcode.transcode') : t('features.transcode.runRule')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p style={{ margin: 0 }}>
          <span className="al-num">{fileLabel}</span>
        </p>
        {rules.isSuccess && enabled.length === 0 ? <Banner tone="warn">{t('features.transcode.noEnabledRules')}</Banner> : null}
        <FormRow label={t('features.transcode.rule')} htmlFor={selectId} caption={choice === '' ? t('features.transcode.firstMatchingRuleCaption') : undefined}>
          <Select id={selectId} value={choice} options={ruleOptions(rules.data)} onChange={(e) => setChoice(e.currentTarget.value as TranscodeChoice)} />
        </FormRow>
        {choice !== '' ? <Banner tone="warn">{t('features.transcode.ruleRunsOnLibrary')}</Banner> : null}
        {run.error ? (
          <p className="al-inline-error" role="alert">
            {errorMessage(run.error)}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** "Transcode now" button for a file row; opens the dialog. Hidden for non-admins. */
export function TranscodeNowButton({ mediaFileId, fileLabel, size = 'sm' }: { mediaFileId: number; fileLabel: string; size?: 'sm' | 'md' }) {
  const { isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  if (!isAdmin) return null;
  return (
    <>
      <Button size={size} variant="ghost" onClick={() => setOpen(true)} aria-label={t('features.transcode.transcodeFile', { file: fileLabel })}>
        {t('features.transcode.transcodeNow')}
      </Button>
      {open ? <TranscodeNowDialog mediaFileId={mediaFileId} fileLabel={fileLabel} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
