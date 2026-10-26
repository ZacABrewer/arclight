import { useState } from 'react';
import type { ApproveRequest, MediaRequest, MinimumAvailability, MonitorOption } from '@arclight/shared';
import { kindOf } from '../../api/requests.js';
import { Button, Checkbox, FormRow, Modal, Select } from '../../arclight/index.js';
import { TagPicker } from '../../components/media/tag-picker.js';
import { useToast } from '../../components/toast.js';
import { useQualityProfiles, useRootFolders } from '../../hooks/library.js';
import { useApproveRequest, useTitle } from '../../hooks/requests.js';
import { MINIMUM_AVAILABILITY_LABELS, MONITOR_OPTION_LABELS } from '../library/add-form.js';
import { t } from '../../i18n/index.js';

/** Approver overrides as edited in the dialog. Empty strings mean "use the request or settings default". */
export interface ApproveDraft {
  rootFolderPath: string;
  qualityProfileId: string;
  tags: number[];
  monitorOption: MonitorOption | '';
  minimumAvailability: MinimumAvailability | '';
  seasons: number[];
}

export function approveDraftFor(r: MediaRequest): ApproveDraft {
  return {
    rootFolderPath: r.rootFolderPath ?? '',
    qualityProfileId: r.qualityProfileId ? String(r.qualityProfileId) : '',
    tags: [...r.tags],
    monitorOption: '',
    minimumAvailability: '',
    seasons: r.seasons.map((s) => s.seasonNumber),
  };
}

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n) => b.includes(n));

/**
 * POST /request/:id/approve body: only what was chosen. Series send `monitorOption` and, when
 * changed, `seasons`; movies send `minimumAvailability`.
 */
export function buildApproveBody(r: MediaRequest, d: ApproveDraft): ApproveRequest {
  const body: ApproveRequest = { tags: [...d.tags] };
  if (d.rootFolderPath) body.rootFolderPath = d.rootFolderPath;
  if (d.qualityProfileId) body.qualityProfileId = Number(d.qualityProfileId);
  if (r.type === 'series') {
    if (d.monitorOption) body.monitorOption = d.monitorOption;
    const requested = r.seasons.map((s) => s.seasonNumber);
    if (d.seasons.length > 0 && !sameSet(d.seasons, requested)) body.seasons = [...d.seasons].sort((a, b) => a - b);
  } else if (d.minimumAvailability) {
    body.minimumAvailability = d.minimumAvailability;
  }
  return body;
}

/** Approve with last-minute overrides (MANAGE_REQUESTS). Defaults come from the request. */
export function ApproveDialog({ request, onClose }: { request: MediaRequest; onClose: () => void }) {
  const approve = useApproveRequest();
  const toast = useToast();
  const rootFolders = useRootFolders();
  const profiles = useQualityProfiles();
  const isSeries = request.type === 'series';
  const title = useTitle(kindOf(request.type), isSeries ? request.mediaTmdbId : 0);
  const [draft, setDraft] = useState<ApproveDraft>(() => approveDraftFor(request));
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ApproveDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const seasonChoices = title.data?.seasons.map((s) => s.seasonNumber) ?? request.seasons.map((s) => s.seasonNumber);

  const submit = () => {
    if (isSeries && draft.seasons.length === 0) {
      setError(t('requests.approveDialog.keepAtLeastOneSeason'));
      return;
    }
    setError(null);
    approve.mutate(
      { id: request.id, body: buildApproveBody(request, draft) },
      {
        onSuccess: () => {
          toast.push({ tone: 'ok', title: t('requests.approveDialog.approvedMediatitle', { mediaTitle: request.mediaTitle }) });
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('requests.approveDialog.approveMediatitle', { mediaTitle: request.mediaTitle })}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={approve.isPending} onClick={submit}>
            {t('requests.approveDialog.approveRequest')}
          </Button>
        </>
      }
    >
      <div className="mk-stack-sm">
        <FormRow label={t('common.rootFolder')} htmlFor="approve-root">
          <Select id="approve-root" value={draft.rootFolderPath} onChange={(e) => set({ rootFolderPath: e.currentTarget.value })}>
            <option value="">{t('common.defaultFolder')}</option>
            {(rootFolders.data ?? [])
              .filter((f) => f.mediaType === request.type)
              .map((f) => (
                <option key={f.id} value={f.path}>
                  {f.path}
                </option>
              ))}
          </Select>
        </FormRow>
        <FormRow label={t('common.qualityTarget')} htmlFor="approve-profile">
          <Select id="approve-profile" value={draft.qualityProfileId} onChange={(e) => set({ qualityProfileId: e.currentTarget.value })}>
            <option value="">{t('common.defaultProfile')}</option>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormRow>
        <FormRow label={t('common.tags')}>
          <TagPicker value={draft.tags} onChange={(tags) => set({ tags })} />
        </FormRow>
        {isSeries ? (
          <>
            <FormRow label={t('common.monitor')} htmlFor="approve-monitor" caption={t('requests.approveDialog.whichEpisodesAreMonitoredWhen')}>
              <Select id="approve-monitor" value={draft.monitorOption} onChange={(e) => set({ monitorOption: e.currentTarget.value as MonitorOption | '' })}>
                <option value="">{t('requests.approveDialog.requestedSeasons')}</option>
                {(Object.keys(MONITOR_OPTION_LABELS) as MonitorOption[]).map((o) => (
                  <option key={o} value={o}>
                    {MONITOR_OPTION_LABELS[o]}
                  </option>
                ))}
              </Select>
            </FormRow>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="al-label" style={{ marginBottom: 10 }}>
                {t('common.seasons')}
              </legend>
              <div className="mk-check-grid">
                {seasonChoices.map((n) => (
                  <Checkbox
                    key={n}
                    label={n === 0 ? t('common.specials') : t('requests.approveDialog.seasonN', { n })}
                    checked={draft.seasons.includes(n)}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      setDraft((d) => ({ ...d, seasons: on ? [...d.seasons, n] : d.seasons.filter((x) => x !== n) }));
                    }}
                  />
                ))}
              </div>
            </fieldset>
          </>
        ) : (
          <FormRow label={t('common.minimumAvailability')} htmlFor="approve-availability">
            <Select
              id="approve-availability"
              value={draft.minimumAvailability}
              onChange={(e) => set({ minimumAvailability: e.currentTarget.value as MinimumAvailability | '' })}
            >
              <option value="">{t('requests.approveDialog.requestsDefault')}</option>
              {(Object.keys(MINIMUM_AVAILABILITY_LABELS) as MinimumAvailability[]).map((o) => (
                <option key={o} value={o}>
                  {MINIMUM_AVAILABILITY_LABELS[o]}
                </option>
              ))}
            </Select>
          </FormRow>
        )}
        {error ? (
          <p className="al-field__error" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
