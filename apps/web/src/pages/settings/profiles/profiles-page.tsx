import { useState } from 'react';
import type { MediaDomain, ProfileMigrationProgress, QualityProfile } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, QualityTag, SectionLabel, Skeleton } from '../../../arclight/index.js';
import { useFeatures } from '../../../hooks/music.js';
import { useCustomFormatList, useQualityProfileList, useQualityProfileSchema } from '../../../hooks/profiles.js';
import { SettingsPage } from '../settings-layout.js';
import { AddCard, CardGrid, ItemCard, SettingsSection, type ItemCardSelect } from '../shared.js';
import { useResourceBulk } from '../../../components/resource-bulk-actions.js';
import { ListSearchBar, ListSearchCount, ListSearchEmpty, useClientListSearch, useListSearch } from '../../../components/list-search.js';
import { useReleaseProfileList } from '../../../hooks/profiles.js';
import { useProfileMigrationProgressList } from '../../../hooks/profile-migration.js';
import { DelayProfilesSection } from './delay-profiles.js';
import { MismatchCount, ProfileMigrationSection } from './profile-migration-section.js';
import { DOMAIN_ORDER, domainLabel, groupByDomain, itemId, itemName, toDisplay } from './quality-profile-model.js';
import { QualityProfileEditor } from './quality-profile-editor.js';
import { ReleaseProfilesSection } from './release-profiles.js';
import { AlbumTypeProfilesSection } from './album-type-profiles.js';
import './profiles.css';
import { t } from '../../../i18n/index.js';

/** One quality profile card: cutoff + the allowed qualities (best first) as mono quality tags. */
export function QualityProfileCard({
  profile,
  onEdit,
  migration,
  select,
}: {
  profile: QualityProfile;
  onEdit: () => void;
  migration?: ProfileMigrationProgress | undefined;
  select?: ItemCardSelect | undefined;
}) {
  const cutoff = profile.items.find((i) => itemId(i) === profile.cutoff);
  const allowed = toDisplay(profile.items).filter((i) => i.allowed);
  return (
    <ItemCard
      title={profile.name}
      onClick={onEdit}
      select={select}
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

type Editing = { profile: QualityProfile } | { domain: MediaDomain } | null;

function QualityProfilesSection() {
  const list = useQualityProfileList();
  const schema = useQualityProfileSchema();
  const formats = useCustomFormatList();
  const migration = useProfileMigrationProgressList();
  const features = useFeatures();
  const [editing, setEditing] = useState<Editing>(null);
  // The page search (ProfilesSearch) filters the cards by name; Select all picks the matches.
  const search = useClientListSearch(list.data, (p) => [p.name]);
  const bulk = useResourceBulk('qualityprofile', search.rows, (p) => p.id, (p) => p.name);

  // One grid per domain once audio is in play: video always, music / audiobooks while their
  // flag is on or a profile of theirs exists. While searching, domains without a match hide.
  const allGroups = groupByDomain(list.data ?? []);
  const groups = groupByDomain(search.rows ?? []);
  const domains = DOMAIN_ORDER.filter(
    (d) => d === 'video' || allGroups.some((g) => g.domain === d) || (d === 'music' ? features.music : features.audiobooks),
  );
  const shown = search.active ? domains.filter((d) => groups.some((g) => g.domain === d)) : domains;
  const grouped = domains.length > 1;
  const card = (p: QualityProfile) => (
    <QualityProfileCard
      key={p.id}
      profile={p}
      onEdit={() => setEditing({ profile: p })}
      migration={migration.data?.find((m) => m.qualityProfileId === p.id)}
      select={bulk.cardProps(p)}
    />
  );

  return (
    <SettingsSection
      label={t('settings.profiles.qualityProfiles')}
      {...(list.data ? { count: list.data.length } : {})}
      action={
        <>
          <ListSearchCount active={search.active} shown={list.data ? search.shown : undefined} total={search.total} />
          <Button size="sm" variant="secondary" onClick={() => setEditing({ domain: 'video' })} disabled={!schema.data}>
            {t('settings.profiles.addQualityProfile')}
          </Button>
        </>
      }
    >
      {list.isPending ? (
        <Skeleton lines={3} />
      ) : list.isError ? (
        <ErrorBlock title={t('settings.profiles.couldntLoadQualityProfiles')} onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : search.active && search.shown === 0 && search.total > 0 ? (
        <ListSearchEmpty query={search.q} onClear={search.clear} />
      ) : grouped ? (
        <>
        {shown.map((domain) => {
          const profiles = groups.find((g) => g.domain === domain)?.profiles ?? [];
          const label = t('settings.profiles.domain.profilesOf', { domain: domainLabel(domain) });
          return (
            <section key={domain} className="al-profile-domain" aria-label={label} data-testid={`profiles-${domain}`}>
              <SectionLabel as="h3" count={profiles.length}>
                {domainLabel(domain)}
              </SectionLabel>
              <CardGrid label={label}>
                {profiles.map(card)}
                <AddCard label={t('settings.profiles.domain.addProfileOf', { domain: domainLabel(domain) })} onClick={() => setEditing({ domain })} />
              </CardGrid>
            </section>
          );
        })}
        </>
      ) : (
        <>
          <CardGrid label={t('settings.profiles.qualityProfiles')}>
            {(search.rows ?? []).map(card)}
            <AddCard label={t('settings.profiles.addQualityProfile')} onClick={() => setEditing({ domain: 'video' })} />
          </CardGrid>
        </>
      )}
      {bulk.bar}
      {editing && schema.data ? (
        <QualityProfileEditor
          key={'profile' in editing ? editing.profile.id : `new-${editing.domain}`}
          profile={'profile' in editing ? editing.profile : null}
          template={schema.data}
          initialDomain={'domain' in editing ? editing.domain : undefined}
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

/**
 * One search box for the profile cards of every section (quality, release and album type
 * profiles, by name; release profiles also by their terms). The query is kept in the URL.
 * Each section shows its own "N of M". Delay profiles are an ordered table and stay whole.
 */
function ProfilesSearch() {
  const { q, setQ, active } = useListSearch();
  const quality = useQualityProfileList();
  const release = useReleaseProfileList();
  if (!active && !quality.data?.length && !release.data?.length) return null;
  return <ListSearchBar value={q} onChange={setQ} placeholder={t('listSearch.ph.names')} />;
}

export function ProfilesPage() {
  return (
    <SettingsPage title={t('common.profiles')} description={t('settings.profiles.whichReleasesToGrabHow')}>
      <ProfilesSearch />
      <QualityProfilesSection />
      <ProfileMigrationPanel />
      <DelayProfilesSection />
      <ReleaseProfilesSection />
      <AlbumTypeProfilesSection />
    </SettingsPage>
  );
}
