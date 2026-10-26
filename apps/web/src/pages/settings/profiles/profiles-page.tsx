import { useState } from 'react';
import type { QualityProfile } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, QualityTag, Skeleton } from '../../../arclight/index.js';
import { useCustomFormatList, useQualityProfileList, useQualityProfileSchema } from '../../../hooks/profiles.js';
import { SettingsPage } from '../settings-layout.js';
import { AddCard, CardGrid, ItemCard, SettingsSection } from '../shared.js';
import { DelayProfilesSection } from './delay-profiles.js';
import { itemId, itemName, toDisplay } from './quality-profile-model.js';
import { QualityProfileEditor } from './quality-profile-editor.js';
import { ReleaseProfilesSection } from './release-profiles.js';
import './profiles.css';

/** One quality profile card: cutoff + the allowed qualities (best first) as mono quality tags. */
export function QualityProfileCard({ profile, onEdit }: { profile: QualityProfile; onEdit: () => void }) {
  const cutoff = profile.items.find((i) => itemId(i) === profile.cutoff);
  const allowed = toDisplay(profile.items).filter((i) => i.allowed);
  return (
    <ItemCard
      title={profile.name}
      onClick={onEdit}
      status={
        profile.upgradeAllowed ? null : (
          <Chip tone="muted" dot="none">
            Upgrades off
          </Chip>
        )
      }
    >
      <span className="al-profile-card__cutoff">
        <span className="al-profile-card__label">Cutoff</span>
        {cutoff ? <QualityTag data-cutoff="true">{itemName(cutoff)}</QualityTag> : <span className="al-muted">Not set</span>}
      </span>
      <span className="al-profile-card__tags" aria-label={`Allowed qualities in ${profile.name}`}>
        {allowed.map((i) => (
          <QualityTag key={`${i.kind}-${itemId(i)}`}>{itemName(i)}</QualityTag>
        ))}
      </span>
    </ItemCard>
  );
}

function QualityProfilesSection() {
  const list = useQualityProfileList();
  const schema = useQualityProfileSchema();
  const formats = useCustomFormatList();
  const [editing, setEditing] = useState<QualityProfile | 'new' | null>(null);

  return (
    <SettingsSection
      label="Quality profiles"
      {...(list.data ? { count: list.data.length } : {})}
      action={
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')} disabled={!schema.data}>
          Add quality profile
        </Button>
      }
    >
      {list.isPending ? (
        <Skeleton lines={3} />
      ) : list.isError ? (
        <ErrorBlock title="Couldn't load quality profiles" onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : (
        <CardGrid label="Quality profiles">
          {list.data.map((p) => (
            <QualityProfileCard key={p.id} profile={p} onEdit={() => setEditing(p)} />
          ))}
          <AddCard label="Add quality profile" onClick={() => setEditing('new')} />
        </CardGrid>
      )}
      {editing && schema.data ? (
        <QualityProfileEditor
          key={editing === 'new' ? 'new' : editing.id}
          profile={editing === 'new' ? null : editing}
          template={schema.data}
          customFormats={formats.data ?? []}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

export function ProfilesPage() {
  return (
    <SettingsPage title="Profiles" description="Which releases to grab, how long to wait for a better one, and which words to require or reject.">
      <QualityProfilesSection />
      <DelayProfilesSection />
      <ReleaseProfilesSection />
    </SettingsPage>
  );
}
