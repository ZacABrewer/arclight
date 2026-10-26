import { useMemo, useState } from 'react';
import type { CreateRequest, RequestsSettings, RootFolder, TitleDetail, TitleSeason } from '@media-tron/shared';
import { errorMessage } from '../../api/client.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { FormField, Select, Toggle } from '../../components/form.js';
import { TagPicker } from '../../components/forms/tag-picker.js';
import { Modal } from '../../components/modal.js';
import { useToast } from '../../components/toast.js';
import { useQualityProfiles, useRootFolders } from '../../hooks/library.js';
import { useCreateRequest, useRequestsSettings } from '../../hooks/requests.js';
import { MEDIA_STATUS_META, REQUEST_STATUS_META } from './status.js';

/** Why a season cannot be requested on a track, or null when it can. */
export function seasonBlocker(season: TitleSeason, is4k: boolean): string | null {
  const status = is4k ? season.status4k : season.status;
  const requestStatus = is4k ? season.requestStatus4k : season.requestStatus;
  if (status !== 'unknown') return MEDIA_STATUS_META[status].label;
  if (requestStatus && requestStatus !== 'declined' && requestStatus !== 'failed') return REQUEST_STATUS_META[requestStatus].label;
  return null;
}

/** Whether the 4K toggle applies to this title. */
export function show4kToggle(title: Pick<TitleDetail, 'mediaType' | 'canRequest4k'>, settings: RequestsSettings | undefined): boolean {
  if (!title.canRequest4k || !settings) return false;
  return title.mediaType === 'movie' ? settings.movie4k.enabled : settings.series4k.enabled;
}

export interface RequestDialogProps {
  title: TitleDetail;
  open: boolean;
  onClose: () => void;
}

export function RequestDialog({ title, open, onClose }: RequestDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={`Request ${title.title}`} size="md">
      {open ? <RequestForm title={title} onClose={onClose} /> : null}
    </Modal>
  );
}

function RequestForm({ title, onClose }: { title: TitleDetail; onClose: () => void }) {
  const settings = useRequestsSettings();
  const toast = useToast();
  const create = useCreateRequest();
  const isSeries = title.mediaType === 'series';
  const [is4k, setIs4k] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [all, setAll] = useState(false);
  const [rootFolderPath, setRootFolderPath] = useState('');
  const [profileId, setProfileId] = useState('');
  const [tags, setTags] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  const partial = settings.data?.partialRequestsEnabled ?? true;
  const specials = settings.data?.enableSpecialEpisodes ?? false;
  const seasons = useMemo(
    () => title.seasons.filter((s) => specials || s.seasonNumber > 0).sort((a, b) => a.seasonNumber - b.seasonNumber),
    [title.seasons, specials],
  );
  const requestable = seasons.filter((s) => seasonBlocker(s, is4k) === null).map((s) => s.seasonNumber);
  const allSelected = !partial || all;
  const chosen = allSelected ? requestable : selected.filter((n) => requestable.includes(n));

  const toggleSeason = (n: number) => {
    setAll(false);
    setSelected((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]));
  };

  const submit = () => {
    if (isSeries && chosen.length === 0) {
      setError('Pick at least one season.');
      return;
    }
    setError(null);
    const body: CreateRequest = {
      mediaType: title.mediaType,
      tmdbId: title.tmdbId,
      is4k,
      ...(isSeries ? { seasons: allSelected ? ('all' as const) : chosen } : {}),
      ...(title.canRequestAdvanced && rootFolderPath ? { rootFolderPath } : {}),
      ...(title.canRequestAdvanced && profileId ? { qualityProfileId: Number(profileId) } : {}),
      ...(title.canRequestAdvanced && tags.length ? { tags } : {}),
    };
    create.mutate(body, {
      onSuccess: (outcome) => {
        if (outcome.kind === 'accepted') toast.push({ tone: 'info', title: outcome.message });
        else
          toast.push({
            tone: 'ok',
            title: outcome.request.status === 'pending' ? 'Request submitted for approval' : 'Request approved',
            message: title.title,
          });
        onClose();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <div className="stack-sm">
      {show4kToggle(title, settings.data) ? (
        <FormField label="4K" inline hint="Request the 4K version instead of the standard one.">
          <Toggle
            aria-label="Request in 4K"
            checked={is4k}
            onChange={(e) => {
              setIs4k(e.currentTarget.checked);
              setSelected([]);
            }}
          />
        </FormField>
      ) : null}

      {isSeries ? (
        <fieldset className="perm-group">
          <legend>Seasons</legend>
          {partial ? (
            <label className="check">
              <input
                type="checkbox"
                aria-label="All seasons"
                checked={all}
                disabled={requestable.length === 0}
                onChange={(e) => {
                  setAll(e.currentTarget.checked);
                  if (!e.currentTarget.checked) setSelected([]);
                }}
              />
              All seasons
            </label>
          ) : (
            <p className="muted small">Series requests cover every season not already requested or available.</p>
          )}
          <div className="season-picker">
            {seasons.map((s) => {
              const blocker = seasonBlocker(s, is4k);
              const label = s.name ?? (s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`);
              return (
                <label key={s.seasonNumber} className="season-picker-row">
                  <span className="check">
                    <input
                      type="checkbox"
                      aria-label={label}
                      disabled={blocker !== null || !partial}
                      checked={blocker === null && (allSelected || selected.includes(s.seasonNumber))}
                      onChange={() => toggleSeason(s.seasonNumber)}
                    />
                    {label}
                    <span className="muted small">{s.episodeCount} episodes</span>
                  </span>
                  {blocker ? <Badge tone="neutral">{blocker}</Badge> : null}
                </label>
              );
            })}
            {seasons.length === 0 ? <p className="muted">No season information.</p> : null}
          </div>
        </fieldset>
      ) : null}

      {title.canRequestAdvanced ? <AdvancedSection {...{ isSeries, rootFolderPath, setRootFolderPath, profileId, setProfileId, tags, setTags }} /> : null}

      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="editor-footer">
        <div className="editor-footer-left" />
        <div className="editor-footer-right">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            {isSeries && !allSelected ? `Request ${chosen.length} season${chosen.length === 1 ? '' : 's'}` : 'Request'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AdvancedSection(props: {
  isSeries: boolean;
  rootFolderPath: string;
  setRootFolderPath: (v: string) => void;
  profileId: string;
  setProfileId: (v: string) => void;
  tags: number[];
  setTags: (v: number[]) => void;
}) {
  const rootFolders = useRootFolders();
  const profiles = useQualityProfiles();
  const folders = (rootFolders.data ?? []).filter((f: RootFolder) => f.mediaType === (props.isSeries ? 'series' : 'movie'));
  return (
    <details className="perm-group" data-testid="request-advanced">
      <summary>Advanced</summary>
      <FormField label="Root folder">
        <Select value={props.rootFolderPath} onChange={(e) => props.setRootFolderPath(e.currentTarget.value)}>
          <option value="">Default</option>
          {folders.map((f) => (
            <option key={f.id} value={f.path}>
              {f.path}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Quality profile">
        <Select value={props.profileId} onChange={(e) => props.setProfileId(e.currentTarget.value)}>
          <option value="">Default</option>
          {(profiles.data ?? []).map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.name}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Tags">
        <TagPicker value={props.tags} onChange={props.setTags} />
      </FormField>
    </details>
  );
}
