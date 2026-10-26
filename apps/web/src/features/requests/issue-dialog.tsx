import { useState } from 'react';
import { IssueType, type MediaType, type TitleSeason } from '@media-tron/shared';
import { errorMessage } from '../../api/client.js';
import { FormField, Input, Select } from '../../components/form.js';
import { Modal } from '../../components/modal.js';
import { useToast } from '../../components/toast.js';
import { useCreateIssue } from '../../hooks/requests.js';
import { EditorFooter } from '../../pages/settings/shared.js';
import { ISSUE_TYPE_LABELS } from './status.js';

export interface ReportIssueTarget {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  seasons: readonly TitleSeason[];
}

export function ReportIssueDialog({ target, open, onClose }: { target: ReportIssueTarget; open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={`Report an issue with ${target.title}`}>
      {open ? <IssueForm target={target} onClose={onClose} /> : null}
    </Modal>
  );
}

function IssueForm({ target, onClose }: { target: ReportIssueTarget; onClose: () => void }) {
  const create = useCreateIssue();
  const toast = useToast();
  const [type, setType] = useState<IssueType>('video');
  const [season, setSeason] = useState(0);
  const [episode, setEpisode] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const isSeries = target.mediaType === 'series';

  const submit = () => {
    if (!message.trim()) {
      setError('Describe the problem.');
      return;
    }
    setError(null);
    create.mutate(
      {
        type,
        mediaType: target.mediaType,
        tmdbId: target.tmdbId,
        message: message.trim(),
        problemSeason: isSeries ? season : 0,
        problemEpisode: isSeries && season > 0 ? episode : 0,
      },
      {
        onSuccess: () => {
          toast.push({ tone: 'ok', title: 'Issue reported', message: target.title });
          onClose();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <div className="stack-sm">
      <FormField label="Problem type">
        <Select
          value={type}
          onChange={(e) => setType(e.currentTarget.value as IssueType)}
          options={IssueType.options.map((t) => ({ value: t, label: ISSUE_TYPE_LABELS[t] }))}
        />
      </FormField>
      {isSeries ? (
        <div className="fields-row">
          <FormField label="Season">
            <Select value={String(season)} onChange={(e) => setSeason(Number(e.currentTarget.value))}>
              <option value="0">All seasons</option>
              {target.seasons.map((s) => (
                <option key={s.seasonNumber} value={String(s.seasonNumber)}>
                  {s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Episode" hint="0: the whole season">
            <Input type="number" min={0} disabled={season === 0} value={episode} onChange={(e) => setEpisode(Math.max(0, Number(e.currentTarget.value) || 0))} />
          </FormField>
        </div>
      ) : null}
      <FormField label="What is wrong?">
        <textarea className="input textarea" rows={4} value={message} onChange={(e) => setMessage(e.currentTarget.value)} />
      </FormField>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <EditorFooter onCancel={onClose} onSave={submit} saving={create.isPending} saveLabel="Report issue" />
    </div>
  );
}
