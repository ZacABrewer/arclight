import { useState } from 'react';
import type { ProfileMigrationProgress, QualityProfile } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, QualityTag, Skeleton } from '../../../arclight/index.js';
import { useCustomFormatList, useQualityProfileList, useQualityProfileSchema } from '../../../hooks/profiles.js';
import { SettingsPage } from '../settings-layout.js';
import { AddCard, CardGrid, ItemCard, SettingsSection } from '../shared.js';
import { useProfileMigrationProgressList } from '../../../hooks/profile-migration.js';
import { DelayProfilesSection } from './delay-profiles.js';
import { MismatchCount, ProfileMigrationSection } from './profile-migration-section.js';
import { itemId, itemName, toDisplay } from './quality-profile-model.js';
import { QualityProfileEditor } from './quality-profile-editor.js';
import { ReleaseProfilesSection } from './release-profiles.js';
import './profiles.css';
import { t } from '../../../i18n/index.js';

/** One quality profile card: cutoff + the allowed qualities (best first) as mono quality tags. */
export function QualityProfileCard({ profile, onEdit, migration }: { profile: QualityProfile; onEdit: () => void; migration?: ProfileMigrationProgress | undefined }) {
  const cutoff = profile.items.find((i) => itemId(i) === profile.cutoff);
  const allowed = toDisplay(profile.items).filter((i) => i.allowed);
  return (
    <ItemCard
      title={profile.name}
      onClick={onEdit}
      status={
        profile.upgradeAllowed ? null : (
          <Chip tone="muted" dot="none">
            {t('settings.profiles.upgradesOff')}
          </Chip>
        )
      }
    >
      <span className="al-profile-card__cutoff">
        <span className="al-profile-card__label">{t('settings.profiles.cutoff')}</span>
        {cutoff ? <QualityTag data-cutoff="true">{itemName(cutoff)}</QualityTag> : <span className="al-muted">{t('settings.profiles.notSet')}</span>}
      </span>
      <span className="al-profile-card__tags" aria-label={t('settings.profiles.allowedQualitiesInName', { name: profile.name })}>
        {allowed.map((i) => (
          <QualityTag key={`${i.kind}-${itemId(i)}`}>{itemName(i)}</QualityTag>
        ))}
      </span>
      <MismatchCount progress={migration} />
    </ItemCard>
  );
}

function QualityProfilesSection() {
  const list = useQualityProfileList();
  const schema = useQualityProfileSchema();
  const formats = useCustomFormatList();
  const migration = useProfileMigrationProgressList();
  const [editing, setEditing] = useState<QualityProfile | 'new' | null>(null);

  return (
    <SettingsSection
      label={t('settings.profiles.qualityProfiles')}
      {...(list.data ? { count: list.data.length } : {})}
      action={
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')} disabled={!schema.data}>
          {t('settings.profiles.addQualityProfile')}
        </Button>
      }
    >
      {list.isPending ? (
        <Skeleton lines={3} />
      ) : list.isError ? (
        <ErrorBlock title={t('settings.profiles.couldntLoadQualityProfiles')} onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : (
        <CardGrid label={t('settings.profiles.qualityProfiles')}>
          {list.data.map((p) => (
            <QualityProfileCard key={p.id} profile={p} onEdit={() => setEditing(p)} migration={migration.data?.find((m) => m.qualityProfileId === p.id)} />
          ))}
          <AddCard label={t('settings.profiles.addQualityProfile')} onClick={() => setEditing('new')} />
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

function ProfileMigrationPanel() {
  const list = useQualityProfileList();
  return <ProfileMigrationSection profiles={list.data} />;
}

export function ProfilesPage() {
  return (
    <SettingsPage title={t('common.profiles')} description={t('settings.profiles.whichReleasesToGrabHow')}>
      <QualityProfilesSection />
      <ProfileMigrationPanel />
      <DelayProfilesSection />
      <ReleaseProfilesSection />
    </SettingsPage>
  );
}
