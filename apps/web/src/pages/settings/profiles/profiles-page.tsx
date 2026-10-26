import { useState } from 'react';
import type { QualityProfile } from '@arclight/shared';
import { Badge } from '../../../components/badge.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useCustomFormatList, useQualityProfileList, useQualityProfileSchema } from '../../../hooks/profiles.js';
import { AddCard, CardGrid, ItemCard } from '../shared.js';
import { DelayProfilesSection } from './delay-profiles.js';
import { itemId, itemName, toDisplay } from './quality-profile-model.js';
import { QualityProfileEditor } from './quality-profile-editor.js';
import { ReleaseProfilesSection } from './release-profiles.js';

function QualityProfilesSection() {
  const list = useQualityProfileList();
  const schema = useQualityProfileSchema();
  const formats = useCustomFormatList();
  const [editing, setEditing] = useState<QualityProfile | 'new' | null>(null);

  return (
    <Card title="Quality profiles">
      {list.isPending ? (
        <LoadingBlock />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <CardGrid>
          {list.data.map((p) => {
            const cutoff = p.items.find((i) => itemId(i) === p.cutoff);
            return (
              <ItemCard key={p.id} title={p.name} onClick={() => setEditing(p)}>
                <div className="muted">
                  Cutoff: {cutoff ? itemName(cutoff) : '—'}
                  {p.upgradeAllowed ? '' : ' · upgrades off'}
                </div>
                <div className="badge-row">
                  {toDisplay(p.items)
                    .filter((i) => i.allowed)
                    .map((i) => (
                      <Badge key={`${i.kind}-${itemId(i)}`} tone={itemId(i) === p.cutoff ? 'info' : 'neutral'}>
                        {itemName(i)}
                      </Badge>
                    ))}
                </div>
              </ItemCard>
            );
          })}
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
    </Card>
  );
}

export function ProfilesPage() {
  return (
    <Page title="Profiles">
      <div className="stack">
        <QualityProfilesSection />
        <DelayProfilesSection />
        <ReleaseProfilesSection />
      </div>
    </Page>
  );
}
