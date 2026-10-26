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
import { t } from '../../../i18n/index.js';

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

/** Provider setting key: search this provider only when the others found nothing acceptable. */
export const ONLY_WHEN_NO_OTHER_RESULT = 'onlyWhenNoOtherResult';

/** Whether the provider gets the "Only when no other result" toggle (Whisper, or any schema with the field). */
export function hasFallbackToggle(schema: SubtitleProviderSchema): boolean {
  return schema.id === 'whisperai' || schema.fields.some((f) => f.name === ONLY_WHEN_NO_OTHER_RESULT);
}

/** The stored flag, else the schema field default (Whisper defaults to on). */
export function onlyWhenNoOtherResult(config: SubtitleProviderConfig, schema: SubtitleProviderSchema): boolean {
  const stored = config.settings[ONLY_WHEN_NO_OTHER_RESULT];
  if (typeof stored === 'boolean') return stored;
  const field = schema.fields.find((f) => f.name === ONLY_WHEN_NO_OTHER_RESULT);
  return field ? field.default === true : schema.id === 'whisperai';
}

function testOutcome(r: { ok: boolean; message: string }): TestOutcome {
  return { ok: r.ok, message: r.ok ? r.message : undefined, warnings: [], errors: r.ok ? [] : [r.message] };
}

function StatusChip({ status }: { status: SubtitleProviderStatus | undefined }) {
  if (!status) return null;
  if (status.throttle) return <Chip tone="warn">{t('settings.subtitles.providersCard.rateLimited')}</Chip>;
  if (!status.configured) return <Chip tone="danger">{status.configError ? t('settings.subtitles.providersCard.failedConfigerror', { configError: status.configError }) : t('settings.subtitles.providersCard.notConfigured')}</Chip>;
  return status.enabled ? <Chip tone="accent">{t('settings.subtitles.providersCard.ready')}</Chip> : <Chip tone="muted">{t('common.disabled')}</Chip>;
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
  // The fallback flag gets its own toggle; every other field goes through the schema form.
  const fields = useMemo(() => schema.fields.filter((f) => f.name !== ONLY_WHEN_NO_OTHER_RESULT).map(providerFieldDefinition), [schema]);
  const fallback = hasFallbackToggle(schema);
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
              {t('settings.subtitles.providersCard.nameIsRateLimitedCode', { name: schema.name, code: status.throttle.code, description: status.throttle.description })}
              <time className="al-num" dateTime={status.throttle.until}>
                {formatDateTime(status.throttle.until)}
              </time>
              .
            </p>
          ) : null}
        </div>
        <div className="al-provider-card__body">
          <div className="al-provider-card__row">
            <Toggle label={t('common.enabled')} aria-label={t('settings.subtitles.providersCard.enableName', { name: schema.name })} checked={config.enabled} onChange={(e) => onChange({ enabled: e.currentTarget.checked })} />
            <span className="al-provider-card__order">
              <span className="al-num al-muted">{String(index + 1).padStart(2, '0')}</span>
              <Button size="sm" variant="ghost" aria-label={t('settings.subtitles.providersCard.moveNameUp', { name: schema.name })} disabled={index === 0} onClick={() => onMove(-1)}>
                ↑
              </Button>
              <Button size="sm" variant="ghost" aria-label={t('settings.subtitles.providersCard.moveNameDown', { name: schema.name })} disabled={index === count - 1} onClick={() => onMove(1)}>
                ↓
              </Button>
            </span>
          </div>
          {fallback ? (
            <div className="al-provider-card__fallback">
              <Toggle
                label={t('settings.subtitles.providersCard.onlyWhenNoOtherResult')}
                aria-label={t('settings.subtitles.providersCard.onlyWhenNoOtherResultFor', { name: schema.name })}
                checked={onlyWhenNoOtherResult(config, schema)}
                onChange={(e) => onChange({ settings: { ...config.settings, [ONLY_WHEN_NO_OTHER_RESULT]: e.currentTarget.checked } })}
              />
              <p className="al-caption">{t('settings.subtitles.providersCard.onlyWhenNoOtherResultHelp')}</p>
            </div>
          ) : null}
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
            <p className="al-caption">{t('settings.subtitles.providersCard.noCredentialsNeeded')}</p>
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
      {t('settings.subtitles.providersCard.resetThrottles')}
    </Button>
  );

  if (data.isPending) {
    return (
      <SettingsSection label={t('settings.subtitles.providersCard.providers')} action={action}>
        <Skeleton lines={4} />
      </SettingsSection>
    );
  }
  if (data.isError) {
    return (
      <SettingsSection label={t('settings.subtitles.providersCard.providers')} action={action}>
        <ErrorBlock title={t('settings.subtitles.providersCard.couldNotLoadSubtitleProviders')} onRetry={() => void data.refetch()}>
          {errorMessage(data.error)}
        </ErrorBlock>
      </SettingsSection>
    );
  }

  const list = orderedProviders(providers, data.data.schema);
  const schemaFor = (id: string) => data.data.schema.find((s) => s.id === id)!;
  const update = (id: string, patch: Partial<SubtitleProviderConfig>) => onChange(list.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  return (
    <SettingsSection label={t('settings.subtitles.providersCard.providers')} count={list.length} action={action}>
      <p className="al-caption">{t('settings.subtitles.providersCard.providersAreSearchedInThis')}</p>
      <div className="al-provider-grid">
        <CardGrid label={t('settings.subtitles.providersCard.subtitleProviders')}>
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
