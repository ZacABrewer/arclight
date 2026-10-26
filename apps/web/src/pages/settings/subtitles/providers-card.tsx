import { useMemo, useState } from 'react';
import type { SubtitleProviderConfig, SubtitleProviderField, SubtitleProviderSchema, SubtitleProviderStatus } from '@arclight/shared';
import { subtitlesApi } from '../../../api/subtitles.js';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, Pane, Skeleton, Toggle } from '../../../arclight/index.js';
import { SchemaForm } from '../../../components/forms/schema-form.js';
import { TestButton, type TestOutcome } from '../../../components/forms/test-result.js';
import type { FieldDefinition, FieldErrors, FormValues } from '../../../components/forms/types.js';
import { validateFields } from '../../../components/forms/values.js';
import { useResetProviderThrottles, useSubtitleProviders } from '../../../hooks/subtitles.js';
import { formatDateTime } from '../../../lib/format.js';
import { CardGrid, SettingsSection } from '../shared.js';
import './subtitle-settings.css';

/** Provider field -> schema-form field under `settings.<name>`; secrets render as password inputs. */
export function providerFieldDefinition(f: SubtitleProviderField): FieldDefinition {
  return {
    name: `settings.${f.name}`,
    label: f.label,
    type: f.secret ? 'password' : f.type,
    helpText: f.helpText,
    required: f.required,
    advanced: f.advanced,
    default: f.default,
    options: f.options,
    min: f.min,
    max: f.max,
  };
}

/**
 * Every provider from the schema, in priority order: the configured list first (its order is
 * the priority), then providers that have no entry yet, disabled.
 */
export function orderedProviders(configured: readonly SubtitleProviderConfig[], schema: readonly SubtitleProviderSchema[]): SubtitleProviderConfig[] {
  const known = new Set(schema.map((s) => s.id));
  const listed = configured.filter((p) => known.has(p.id));
  const missing = schema.filter((s) => !listed.some((p) => p.id === s.id)).map((s) => ({ id: s.id, enabled: false, settings: {} }));
  return [...listed, ...missing];
}

export function moveProvider(list: readonly SubtitleProviderConfig[], index: number, delta: -1 | 1): SubtitleProviderConfig[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

function testOutcome(r: { ok: boolean; message: string }): TestOutcome {
  return { ok: r.ok, message: r.ok ? r.message : undefined, warnings: [], errors: r.ok ? [] : [r.message] };
}

function StatusChip({ status }: { status: SubtitleProviderStatus | undefined }) {
  if (!status) return null;
  if (status.throttle) return <Chip tone="warn">Rate-limited</Chip>;
  if (!status.configured) return <Chip tone="danger">{status.configError ? `Failed · ${status.configError}` : 'Not configured'}</Chip>;
  return status.enabled ? <Chip tone="accent">Ready</Chip> : <Chip tone="muted">Disabled</Chip>;
}

function ProviderCard({
  schema,
  config,
  status,
  index,
  count,
  showAdvanced,
  onChange,
  onMove,
}: {
  schema: SubtitleProviderSchema;
  config: SubtitleProviderConfig;
  status: SubtitleProviderStatus | undefined;
  index: number;
  count: number;
  showAdvanced: boolean;
  onChange: (patch: Partial<SubtitleProviderConfig>) => void;
  onMove: (delta: -1 | 1) => void;
}) {
  const fields = useMemo(() => schema.fields.map(providerFieldDefinition), [schema]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const values = { settings: config.settings } as FormValues;
  const settings = () => (values.settings ?? {}) as Record<string, unknown>;

  return (
    <div role="listitem" className="al-item-card-wrap">
      <Pane className="al-item-card al-provider-card" aria-label={schema.name} data-muted={!config.enabled || undefined}>
        <div className="al-item-card__head">
          <h3 className="al-item-card__title">{schema.name}</h3>
          <StatusChip status={status} />
        </div>
        <div className="al-item-card__meta">
          <p className="al-provider-card__desc">{schema.description}</p>
          {status?.throttle ? (
            <p className="al-provider-card__throttle" data-testid={`throttle-${status.id}`}>
              {schema.name} is rate-limited ({status.throttle.code}): {status.throttle.description}. Retry at{' '}
              <time className="al-num" dateTime={status.throttle.until}>
                {formatDateTime(status.throttle.until)}
              </time>
              .
            </p>
          ) : null}
        </div>
        <div className="al-provider-card__body">
          <div className="al-provider-card__row">
            <Toggle label="Enabled" aria-label={`Enable ${schema.name}`} checked={config.enabled} onChange={(e) => onChange({ enabled: e.currentTarget.checked })} />
            <span className="al-provider-card__order">
              <span className="al-num al-muted">{String(index + 1).padStart(2, '0')}</span>
              <Button size="sm" variant="ghost" aria-label={`Move ${schema.name} up`} disabled={index === 0} onClick={() => onMove(-1)}>
                ↑
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Move ${schema.name} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
                ↓
              </Button>
            </span>
          </div>
          {fields.length ? (
            <SchemaForm
              fields={fields}
              values={values}
              errors={errors}
              showAdvanced={showAdvanced}
              onChange={(next) => {
                setErrors({});
                onChange({ settings: (next.settings ?? {}) as Record<string, unknown> });
              }}
            />
          ) : (
            <p className="al-caption">No credentials needed.</p>
          )}
        </div>
        <div className="al-item-card__actions">
          <TestButton
            beforeTest={() => {
              const found = validateFields(fields, values);
              setErrors(found);
              return Object.keys(found).length === 0;
            }}
            onTest={async () => testOutcome(await subtitlesApi.testProvider(schema.id, settings()))}
          />
        </div>
      </Pane>
    </div>
  );
}

/** Providers: card grid in priority order, credentials, enable, test, throttle status. Edits the page's settings draft. */
export function ProvidersCard({
  providers,
  onChange,
  showAdvanced = false,
}: {
  providers: readonly SubtitleProviderConfig[];
  onChange: (next: SubtitleProviderConfig[]) => void;
  showAdvanced?: boolean;
}) {
  const data = useSubtitleProviders();
  const reset = useResetProviderThrottles();

  const action = (
    <Button size="sm" variant="secondary" loading={reset.isPending} onClick={() => reset.mutate(false)} disabled={!data.data}>
      Reset throttles
    </Button>
  );

  if (data.isPending) {
    return (
      <SettingsSection label="Providers" action={action}>
        <Skeleton lines={4} />
      </SettingsSection>
    );
  }
  if (data.isError) {
    return (
      <SettingsSection label="Providers" action={action}>
        <ErrorBlock title="Could not load subtitle providers" onRetry={() => void data.refetch()}>
          {errorMessage(data.error)}
        </ErrorBlock>
      </SettingsSection>
    );
  }

  const list = orderedProviders(providers, data.data.schema);
  const schemaFor = (id: string) => data.data.schema.find((s) => s.id === id)!;
  const update = (id: string, patch: Partial<SubtitleProviderConfig>) => onChange(list.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  return (
    <SettingsSection label="Providers" count={list.length} action={action}>
      <p className="al-caption">Providers are searched in this order. Enable the ones you have accounts for; changes apply when you save.</p>
      <div className="al-provider-grid">
        <CardGrid label="Subtitle providers">
          {list.map((p, i) => (
            <ProviderCard
              key={p.id}
              schema={schemaFor(p.id)}
              config={p}
              status={data.data.status.find((s) => s.id === p.id)}
              index={i}
              count={list.length}
              showAdvanced={showAdvanced}
              onChange={(patch) => update(p.id, patch)}
              onMove={(delta) => onChange(moveProvider(list, i, delta))}
            />
          ))}
        </CardGrid>
      </div>
    </SettingsSection>
  );
}
