import type { Indexer, IndexerCategory, IndexerCreate, IndexerImplementation, IndexerTestResult } from '@arclight/shared';
import { INDEXER_PRIORITY_DEFAULT, INDEXER_PRIORITY_MAX, INDEXER_PRIORITY_MIN } from '@arclight/shared';
import type { FieldDefinition, FieldRendererProps, FormValues } from '../../../components/forms/types.js';
import type { TestOutcome } from '../../../components/forms/test-result.js';
import { Checkbox } from '../../../arclight/index.js';
import './indexers.css';

// /indexer/schema returns ready-to-fill templates but no field definitions, so the field list
// for the schema form lives here, written against IndexerSettings in packages/shared.

export function indexerFields(implementation: IndexerImplementation): FieldDefinition[] {
  const torrent = implementation === 'torznab';
  const fields: FieldDefinition[] = [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'enableRss', label: 'Enable RSS', type: 'checkbox', helpText: 'Poll this indexer for new releases.' },
    { name: 'enableAutomaticSearch', label: 'Enable automatic search', type: 'checkbox', helpText: 'Used by automatic and wanted searches.' },
    { name: 'enableInteractiveSearch', label: 'Enable interactive search', type: 'checkbox', helpText: 'Used by manual (interactive) searches.' },
    { name: 'settings.baseUrl', label: 'URL', type: 'text', required: true, placeholder: 'https://indexer.example' },
    { name: 'settings.apiPath', label: 'API path', type: 'text', advanced: true, default: '/api', helpText: 'Path to the API, usually /api.' },
    { name: 'settings.apiKey', label: 'API key', type: 'password' },
    { name: 'settings.categories', label: 'Categories', type: 'multiSelect', helpText: 'Categories searched for standard content.' },
    { name: 'settings.animeCategories', label: 'Anime categories', type: 'multiSelect', advanced: true, helpText: 'Categories searched for anime.' },
  ];
  if (torrent) {
    fields.push(
      { name: 'settings.minimumSeeders', label: 'Minimum seeders', type: 'number', min: 0, advanced: true },
      { name: 'settings.seedRatio', label: 'Seed ratio', type: 'number', min: 0, advanced: true, helpText: 'Empty uses the download client default.' },
      { name: 'settings.seedTime', label: 'Seed time', type: 'number', min: 0, unit: 'min', scale: 60_000, advanced: true },
      { name: 'settings.seasonPackSeedTime', label: 'Season-pack seed time', type: 'number', min: 0, unit: 'min', scale: 60_000, advanced: true },
    );
  }
  fields.push(
    { name: 'settings.additionalParameters', label: 'Additional parameters', type: 'text', advanced: true, placeholder: '&attrs=poster' },
    { name: 'settings.rateLimitSeconds', label: 'Rate limit', type: 'number', min: 0, unit: 's', advanced: true, helpText: 'Minimum seconds between requests.' },
    {
      name: 'priority',
      label: 'Priority',
      type: 'number',
      min: INDEXER_PRIORITY_MIN,
      max: INDEXER_PRIORITY_MAX,
      default: INDEXER_PRIORITY_DEFAULT,
      required: true,
      advanced: true,
      helpText: '1 is the highest, 50 the lowest. Breaks ties between equally good releases.',
    },
    { name: 'tags', label: 'Tags', type: 'text', advanced: true, helpText: 'Only use for items with a matching tag; empty means all.' },
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
    message: r.ok ? `${r.releaseCount ?? 0} releases returned${r.caps?.serverTitle ? ` by ${r.caps.serverTitle}` : ''}` : undefined,
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
  if (categories.length === 0) return <p className="al-caption">No categories reported yet. Test the indexer to load them.</p>;
  return (
    <ul id={id} className="al-cat-tree" aria-label="Categories">
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
