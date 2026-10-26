import type { Indexer, IndexerCategory, IndexerCreate, IndexerImplementation, IndexerTestResult } from '@arclight/shared';
import { INDEXER_PRIORITY_DEFAULT, INDEXER_PRIORITY_MAX, INDEXER_PRIORITY_MIN } from '@arclight/shared';
import type { FieldDefinition, FieldRendererProps, FormValues } from '../../../components/forms/types.js';
import type { TestOutcome } from '../../../components/forms/test-result.js';
import { Checkbox } from '../../../arclight/index.js';
import './indexers.css';
import { t } from '../../../i18n/index.js';

// /indexer/schema returns ready-to-fill templates but no field definitions, so the field list
// for the schema form lives here, written against IndexerSettings in packages/shared.

export function indexerFields(implementation: IndexerImplementation): FieldDefinition[] {
  const torrent = implementation === 'torznab';
  const fields: FieldDefinition[] = [
    { name: 'name', label: t('common.name'), type: 'text', required: true },
    { name: 'enableRss', label: t('settings.indexers.indexerFields.enableRss'), type: 'checkbox', helpText: t('settings.indexers.indexerFields.pollThisIndexerForNew') },
    { name: 'enableAutomaticSearch', label: t('settings.indexers.indexerFields.enableAutomaticSearch'), type: 'checkbox', helpText: t('settings.indexers.indexerFields.usedByAutomaticAndWanted') },
    { name: 'enableInteractiveSearch', label: t('settings.indexers.indexerFields.enableInteractiveSearch'), type: 'checkbox', helpText: t('settings.indexers.indexerFields.usedByManualInteractiveSearches') },
    { name: 'settings.baseUrl', label: t('common.url'), type: 'text', required: true, placeholder: 'https://indexer.example' },
    { name: 'settings.apiPath', label: t('settings.indexers.indexerFields.apiPath'), type: 'text', advanced: true, default: '/api', helpText: t('settings.indexers.indexerFields.pathToTheApiUsually') },
    { name: 'settings.apiKey', label: t('common.apiKey'), type: 'password' },
    { name: 'settings.categories', label: t('common.categories'), type: 'multiSelect', helpText: t('settings.indexers.indexerFields.categoriesSearchedForStandardContent') },
    { name: 'settings.animeCategories', label: t('settings.indexers.indexerFields.animeCategories'), type: 'multiSelect', advanced: true, helpText: t('settings.indexers.indexerFields.categoriesSearchedForAnime') },
  ];
  if (torrent) {
    fields.push(
      { name: 'settings.minimumSeeders', label: t('settings.indexers.indexerFields.minimumSeeders'), type: 'number', min: 0, advanced: true },
      { name: 'settings.seedRatio', label: t('settings.indexers.indexerFields.seedRatio'), type: 'number', min: 0, advanced: true, helpText: t('settings.indexers.indexerFields.emptyUsesTheDownloadClient') },
      { name: 'settings.seedTime', label: t('settings.indexers.indexerFields.seedTime'), type: 'number', min: 0, unit: 'min', scale: 60_000, advanced: true },
      { name: 'settings.seasonPackSeedTime', label: t('settings.indexers.indexerFields.seasonPackSeedTime'), type: 'number', min: 0, unit: 'min', scale: 60_000, advanced: true },
    );
  }
  fields.push(
    { name: 'settings.additionalParameters', label: t('settings.indexers.indexerFields.additionalParameters'), type: 'text', advanced: true, placeholder: '&attrs=poster' },
    { name: 'settings.rateLimitSeconds', label: t('settings.indexers.indexerFields.rateLimit'), type: 'number', min: 0, unit: 's', advanced: true, helpText: t('settings.indexers.indexerFields.minimumSecondsBetweenRequests') },
    {
      name: 'priority',
      label: t('common.priority'),
      type: 'number',
      min: INDEXER_PRIORITY_MIN,
      max: INDEXER_PRIORITY_MAX,
      default: INDEXER_PRIORITY_DEFAULT,
      required: true,
      advanced: true,
      helpText: t('settings.indexers.indexerFields.n1IsTheHighest50'),
    },
    { name: 'tags', label: t('common.tags'), type: 'text', advanced: true, helpText: t('settings.indexers.indexerFields.onlyUseForItemsWith') },
  );
  return fields;
}

/** Form values -> create/test body (drops id, protocol, status and other read-only keys). */
export function toIndexerBody(values: FormValues): IndexerCreate {
  const v = values as Partial<Indexer>;
  const body: IndexerCreate = {
    name: String(v.name ?? ''),
    implementation: v.implementation ?? 'torznab',
    enableRss: v.enableRss ?? true,
    enableAutomaticSearch: v.enableAutomaticSearch ?? true,
    enableInteractiveSearch: v.enableInteractiveSearch ?? true,
    priority: v.priority ?? INDEXER_PRIORITY_DEFAULT,
    tags: v.tags ?? [],
    settings: { ...(v.settings ?? { baseUrl: '', apiPath: '/api', categories: [], animeCategories: [] }) },
  };
  if (v.downloadClientId !== undefined) body.downloadClientId = v.downloadClientId;
  if (v.proxyId !== undefined) body.proxyId = v.proxyId;
  return body;
}

export function indexerTestOutcome(r: IndexerTestResult): TestOutcome {
  return {
    ok: r.ok,
    message: r.ok ? t('settings.indexers.indexerFields.valueReleasesReturnedValue2', { value: r.releaseCount ?? 0, value2: r.caps?.serverTitle ? ` by ${r.caps.serverTitle}` : '' }) : undefined,
    warnings: [],
    errors: r.error ? [`${r.error.message} (${r.error.code})`] : [],
  };
}

/** Selected state of a parent category: all / some / none of its subcategories. */
export function parentState(cat: IndexerCategory, selected: readonly number[]): 'all' | 'some' | 'none' {
  const ids = [cat.id, ...cat.subCategories.map((s) => s.id)];
  const count = ids.filter((id) => selected.includes(id)).length;
  if (selected.includes(cat.id) || (cat.subCategories.length > 0 && count === cat.subCategories.length)) return 'all';
  return count > 0 ? 'some' : 'none';
}

/** Toggling a parent selects/deselects it with every subcategory. */
export function toggleParent(cat: IndexerCategory, selected: readonly number[]): number[] {
  const ids = [cat.id, ...cat.subCategories.map((s) => s.id)];
  const without = selected.filter((id) => !ids.includes(id));
  return parentState(cat, selected) === 'all' ? without : [...without, cat.id];
}

/** Indent per tree level (handoff §9: checkbox tree, 20px per level). */
export const CATEGORY_INDENT = 20;

/**
 * Category checkbox tree: parents at level 0, subcategories 20px in. A parent is checked when
 * it (or every subcategory) is selected and indeterminate when only some are.
 */
export function CategoryTree({
  id,
  categories,
  value,
  onChange,
}: {
  id?: string;
  categories: readonly IndexerCategory[];
  value: readonly number[];
  onChange: (ids: number[]) => void;
}) {
  if (categories.length === 0) return <p className="al-caption">{t('settings.indexers.indexerFields.noCategoriesReportedYetTest')}</p>;
  return (
    <ul id={id} className="al-cat-tree" aria-label={t('common.categories')}>
      {categories.map((cat) => {
        const state = parentState(cat, value);
        return (
          <li key={cat.id} className="al-cat-tree__node">
            <div className="al-cat-tree__row" data-level={0} style={{ paddingLeft: 0 }}>
              <Checkbox
                label={
                  <>
                    {cat.name} <span className="al-cat-tree__id">{cat.id}</span>
                  </>
                }
                checked={state === 'all'}
                indeterminate={state === 'some'}
                onChange={() => onChange(toggleParent(cat, value))}
              />
            </div>
            {cat.subCategories.length > 0 ? (
              <ul className="al-cat-tree__children">
                {cat.subCategories.map((sub) => {
                  const on = value.includes(sub.id) || value.includes(cat.id);
                  return (
                    <li key={sub.id} className="al-cat-tree__row" data-level={1} style={{ paddingLeft: CATEGORY_INDENT }}>
                      <Checkbox
                        label={
                          <>
                            {sub.name} <span className="al-cat-tree__id">{sub.id}</span>
                          </>
                        }
                        checked={on}
                        disabled={value.includes(cat.id)}
                        onChange={() => onChange(on ? value.filter((v) => v !== sub.id) : [...value, sub.id])}
                      />
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function categoryRenderer(categories: readonly IndexerCategory[]) {
  return function CategoryField({ id, value, onChange }: FieldRendererProps) {
    const ids = Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
    return <CategoryTree id={id} categories={categories} value={ids} onChange={onChange} />;
  };
}
