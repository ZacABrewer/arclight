import type { Tag as TagModel, TagEntityType } from '@arclight/shared';
import { Tag, Tooltip } from '../../arclight/index.js';
import { useTagApplications } from '../../hooks/tag-rules.js';
import './media-kit.css';
import { t } from '../../i18n/index.js';

/**
 * An item's tags; tags a tag rule added carry a small ◆ marker and a tooltip naming the rule.
 * Users who may not read rule ownership simply see plain tags.
 */
export function AutoTagChips({
  entityType,
  entityId,
  ids,
  tags,
}: {
  entityType: TagEntityType;
  entityId: number;
  ids: readonly number[];
  tags: readonly TagModel[] | undefined;
}) {
  const applied = useTagApplications(entityType, entityId);
  if (ids.length === 0) return null;
  const rulesFor = new Map<number, string[]>();
  for (const a of applied.data ?? []) rulesFor.set(a.tagId, [...(rulesFor.get(a.tagId) ?? []), a.ruleName]);
  return (
    <span className="mk-tags">
      {ids.map((id) => {
        const label = tags?.find((item) => item.id === id)?.label ?? `#${id}`;
        const rules = rulesFor.get(id);
        if (!rules) return <Tag key={id}>{label}</Tag>;
        const text = t('components.autoTags.addedByRule', { name: rules.join(', ') });
        return (
          <Tooltip key={id} content={text}>
            <Tag tabIndex={0} aria-label={`${label}, ${text}`} data-auto="true">
              {label}
              <span className="mk-tag-auto" aria-hidden="true">
                ◆
              </span>
            </Tag>
          </Tooltip>
        );
      })}
    </span>
  );
}
