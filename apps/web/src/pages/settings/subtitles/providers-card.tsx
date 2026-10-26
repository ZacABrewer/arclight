import { useMemo, useState } from 'react';
import type { SubtitleProviderConfig, SubtitleProviderField, SubtitleProviderSchema, SubtitleProviderStatus } from '@media-tron/shared';
import { subtitlesApi } from '../../../api/subtitles.js';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { Toggle } from '../../../components/form.js';
import { SchemaForm, useSchemaForm } from '../../../components/forms/schema-form.js';
import { TestButton, type TestOutcome } from '../../../components/forms/test-result.js';
import type { FieldDefinition, FormValues } from '../../../components/forms/types.js';
import { Modal } from '../../../components/modal.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useResetProviderThrottles, useSubtitleProviders } from '../../../hooks/subtitles.js';
import { formatDateTime } from '../../../lib/format.js';

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

function ProviderEditor({
  schema,
  config,
  onApply,
  onClose,
}: {
  schema: SubtitleProviderSchema;
  config: SubtitleProviderConfig;
  onApply: (settings: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const fields = useMemo(() => schema.fields.map(providerFieldDefinition), [schema]);
  const form = useSchemaForm(fields, { settings: config.settings } as FormValues);
  const settings = () => (form.values.settings ?? {}) as Record<string, unknown>;

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={`${schema.name} settings`}
      footer={
        <>
          <TestButton beforeTest={form.validate} onTest={async () => testOutcome(await subtitlesApi.testProvider(schema.id, settings()))} />
          <span className="toolbar-spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (!form.validate()) return;
              onApply(settings());
              onClose();
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <p className="muted">{schema.description}</p>
      {fields.length ? (
        <SchemaForm fields={fields} values={form.values} errors={form.errors} onChange={form.setValues} inline />
      ) : (
        <p className="muted">This provider has no settings.</p>
      )}
      <p className="field-hint">Changes take effect when you save the subtitle settings.</p>
    </Modal>
  );
}

function StatusCell({ status }: { status: SubtitleProviderStatus | undefined }) {
  if (!status) return <span className="muted">—</span>;
  if (status.throttle) {
    return (
      <span data-testid={`throttle-${status.id}`}>
        <Badge tone="warning">Throttled · {status.throttle.code}</Badge>{' '}
        <span className="muted">
          {status.throttle.description} · retry at {formatDateTime(status.throttle.until)}
        </span>
      </span>
    );
  }
  if (!status.configured) return <Badge tone="error">{status.configError ?? 'Not configured'}</Badge>;
  return status.enabled ? <Badge tone="ok">Ready</Badge> : <Badge>Disabled</Badge>;
}

/** Providers: enable/disable, priority order, credentials, test, throttle status. Edits the page's settings draft. */
export function ProvidersCard({
  providers,
  onChange,
}: {
  providers: readonly SubtitleProviderConfig[];
  onChange: (next: SubtitleProviderConfig[]) => void;
}) {
  const data = useSubtitleProviders();
  const reset = useResetProviderThrottles();
  const [editing, setEditing] = useState<SubtitleProviderSchema | null>(null);

  if (data.isPending) return <Card title="Providers"><LoadingBlock /></Card>;
  if (data.isError) return <Card title="Providers"><ErrorView error={data.error} onRetry={() => void data.refetch()} /></Card>;

  const list = orderedProviders(providers, data.data.schema);
  const schemaFor = (id: string) => data.data.schema.find((s) => s.id === id)!;
  const update = (id: string, patch: Partial<SubtitleProviderConfig>) => onChange(list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const editingConfig = editing ? list.find((p) => p.id === editing.id) : undefined;

  return (
    <Card
      title="Providers"
      actions={
        <Button size="sm" loading={reset.isPending} onClick={() => reset.mutate(false)}>
          Reset throttles
        </Button>
      }
    >
      <p className="muted">Providers are searched in this order. Enable the ones you have accounts for.</p>
      <table className="table" aria-label="Subtitle providers">
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Provider</th>
            <th scope="col">Enabled</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((p, i) => {
            const schema = schemaFor(p.id);
            return (
              <tr key={p.id}>
                <td>
                  <Button size="sm" variant="ghost" aria-label={`Move ${schema.name} up`} disabled={i === 0} onClick={() => onChange(moveProvider(list, i, -1))}>
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move ${schema.name} down`}
                    disabled={i === list.length - 1}
                    onClick={() => onChange(moveProvider(list, i, 1))}
                  >
                    ↓
                  </Button>
                </td>
                <td>
                  <strong>{schema.name}</strong>
                  <div className="muted">{schema.description}</div>
                </td>
                <td>
                  <Toggle aria-label={`Enable ${schema.name}`} checked={p.enabled} onChange={(e) => update(p.id, { enabled: e.currentTarget.checked })} />
                </td>
                <td>
                  <StatusCell status={data.data.status.find((s) => s.id === p.id)} />
                </td>
                <td className="align-right">
                  <Button size="sm" aria-label={`Edit ${schema.name}`} onClick={() => setEditing(schema)}>
                    Edit
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editing && editingConfig ? (
        <ProviderEditor
          key={editing.id}
          schema={editing}
          config={editingConfig}
          onApply={(settings) => update(editing.id, { settings })}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Card>
  );
}
