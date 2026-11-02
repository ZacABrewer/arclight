import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  ImportList,
  ImportListMediaType,
  ImportListPreviewResult,
  ImportListSchema,
  ImportListTestResult,
  SimklPollResponse,
  TraktPollResponse,
} from '@arclight/shared';
import { importListsApi } from '../../../api/import-lists.js';
import { discoverApi } from '../../../api/requests.js';
import { errorMessage } from '../../../api/client.js';
import { Button, Modal, SectionLabel } from '../../../arclight/index.js';
import { requestKeys } from '../../../hooks/request-keys.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm, useSchemaForm } from '../../../components/forms/schema-form.js';
import { TestResultView } from '../../../components/forms/test-result.js';
import type { FormValues } from '../../../components/forms/types.js';
import { getPath, setPath } from '../../../components/forms/values.js';
import { useDeleteImportList, useSaveImportList } from '../../../hooks/import-lists.js';
import { EditorFooter, SaveError } from '../shared.js';
import { existingListValues, listFields, newListValues, rootsFor, settingsFields, toListBody, type RootFolderOption } from './fields.js';
import { ItemsTable } from './items-table.js';
import { PreviewPanel } from './preview-panel.js';
import { ruleFields, ruleRenderers } from './rules.js';
import { SimklAuth } from './simkl-auth.js';
import { TraktAuth } from './trakt-auth.js';
import { t } from '../../../i18n/index.js';

export type Editing = { list: ImportList; schema: ImportListSchema | undefined } | { schema: ImportListSchema };

export interface EditorProps {
  editing: Editing;
  rootFolders: readonly RootFolderOption[];
  profiles: readonly { id: number; name: string }[];
  onClose: () => void;
}

const TOKEN_FIELDS = ['accessToken', 'refreshToken', 'tokenExpiresAt'] as const;

export function ImportListEditor({ editing, rootFolders, profiles, onClose }: EditorProps) {
  const existing = 'list' in editing ? editing.list : null;
  const schema = editing.schema;
  const base = useMemo<FormValues>(
    () => (existing ? existingListValues(existing) : newListValues(editing.schema!, { rootFolders, profiles })),
    // Start values are taken once, when the dialog opens.
    [],
  );
  const [mediaType, setMediaType] = useState<ImportListMediaType>(base.mediaType as ImportListMediaType);
  const [streamingEnabled, setStreamingEnabled] = useState(getPath(base, 'streaming.enabled') === true);
  const settings = useMemo(() => settingsFields(schema), [schema]);
  // The instance region is only needed once the streaming rule is on.
  const discoverOptions = useQuery({ queryKey: requestKeys.discover.options, queryFn: discoverApi.options, staleTime: 3_600_000, enabled: streamingEnabled, retry: false });
  const defaultRegion = discoverOptions.data?.region;
  const rules = useMemo(() => ruleFields({ mediaType, streamingEnabled, defaultRegion }), [mediaType, streamingEnabled, defaultRegion]);
  const mainFields = useMemo(
    () => [...listFields({ schema, mediaType, rootFolders, profiles }), ...settings.fields],
    [schema, mediaType, rootFolders, profiles, settings.fields],
  );
  const fields = useMemo(() => [...mainFields, ...rules], [mainFields, rules]);
  const form = useSchemaForm(fields, base);
  const regionValue = getPath(form.values, 'streaming.region');
  const region = typeof regionValue === 'string' && /^[A-Za-z]{2}$/.test(regionValue.trim()) ? regionValue.trim().toUpperCase() : undefined;
  const renderers = useMemo(() => ruleRenderers({ mediaType, region }), [mediaType, region]);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ImportListPreviewResult | null>(null);
  const save = useSaveImportList();
  const remove = useDeleteImportList();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ImportListTestResult | null>(null);

  const change = (next: FormValues) => {
    let values = next;
    const nextType = next.mediaType as ImportListMediaType;
    if (nextType !== mediaType) {
      setMediaType(nextType);
      // Keep the root folders valid for the new media type.
      const main = rootsFor(rootFolders, nextType === 'movie' ? 'movie' : 'series');
      if (!main.some((r) => r.path === next.rootFolderPath)) values = { ...values, rootFolderPath: main[0]?.path };
      const movie = rootsFor(rootFolders, 'movie');
      if (nextType === 'both' && !movie.some((r) => r.path === next.movieRootFolderPath)) {
        values = { ...values, movieRootFolderPath: movie[0]?.path };
      }
    }
    setStreamingEnabled(getPath(values, 'streaming.enabled') === true);
    form.setValues(values);
  };

  const submit = () => {
    if (!form.validate()) return;
    save.mutate({ id: existing?.id, body: toListBody(form.values) }, { onSuccess: onClose });
  };

  const runTest = async () => {
    if (!form.validate()) return;
    setTesting(true);
    setTest(null);
    try {
      setTest(await importListsApi.test({ ...toListBody(form.values), ...(existing ? { id: existing.id } : {}) }));
    } catch (err) {
      setTest({ ok: false, error: { code: 'REQUEST', message: errorMessage(err) } });
    } finally {
      setTesting(false);
    }
  };

  const runPreview = async () => {
    if (!form.validate()) return;
    setPreviewing(true);
    setPreview(null);
    try {
      setPreview(await importListsApi.preview({ ...toListBody(form.values), ...(existing ? { id: existing.id } : {}) }));
    } catch (err) {
      setPreview({ ok: false, error: { code: 'REQUEST', message: errorMessage(err) } });
    } finally {
      setPreviewing(false);
    }
  };

  const authorized = (res: TraktPollResponse | SimklPollResponse) => {
    let values = form.values;
    if (res.authRef) values = setPath(values, 'settings.authRef', res.authRef);
    if (res.importList) {
      for (const key of TOKEN_FIELDS) {
        const v = res.importList.settings[key];
        if (v !== undefined) values = setPath(values, `settings.${key}`, v);
      }
    }
    form.setValues(values);
  };

  const clientId = getPath(form.values, 'settings.clientId');
  const clientSecret = getPath(form.values, 'settings.clientSecret');
  const title = existing ? t('settings.importLists.importListEditor.editName', { name: existing.name }) : t('settings.importLists.importListEditor.addValue', { value: schema?.implementationName ?? 'import list' });

  return (
    <>
      <Modal
        open
        size={640}
        onClose={onClose}
        title={title}
        footer={
          <EditorFooter
            onCancel={onClose}
            onSave={submit}
            saving={save.isPending}
            onDelete={existing ? () => setConfirmDelete(true) : undefined}
            extra={
              <>
                <Button variant="secondary" loading={testing} onClick={() => void runTest()}>
                  {t('common.test')}
                </Button>
                <Button variant="secondary" loading={previewing} onClick={() => void runPreview()}>
                  {t('settings.importLists.preview.button')}
                </Button>
              </>
            }
          />
        }
      >
        {schema?.infoLink ? (
          <p className="al-caption">
            <a href={schema.infoLink} target="_blank" rel="noreferrer">
              {t('settings.importLists.importListEditor.aboutImplementationname', { implementationName: schema.implementationName })}
            </a>
          </p>
        ) : null}
        <SchemaForm fields={mainFields} values={form.values} errors={form.errors} onChange={change} renderers={settings.renderers} />
        {schema?.requiresSimklAuth ? (
          <SimklAuth clientId={typeof clientId === 'string' ? clientId : ''} importListId={existing?.id} onAuthorized={authorized} />
        ) : null}
        {schema?.requiresTraktAuth ? (
          <TraktAuth
            clientId={typeof clientId === 'string' ? clientId : ''}
            clientSecret={typeof clientSecret === 'string' ? clientSecret : undefined}
            importListId={existing?.id}
            onAuthorized={authorized}
          />
        ) : null}
        <SectionLabel className="al-il-rules__head">{t('settings.importLists.rules.title')}</SectionLabel>
        <SchemaForm fields={rules} values={form.values} errors={form.errors} onChange={change} renderers={renderers} />
        {preview ? <PreviewPanel result={preview} /> : null}
        {test ? (
          <section aria-label={t('common.testResult')}>
            <TestResultView
              outcome={{
                ok: test.ok,
                message: test.ok ? t('settings.importLists.importListEditor.valueItemsFound', { value: test.itemCount ?? test.items?.length ?? 0 }) : undefined,
                warnings: [],
                errors: test.error ? [test.error.message] : [],
              }}
            />
            {test.ok && test.items?.length ? <ItemsTable caption={t('settings.importLists.importListEditor.firstItems')} items={test.items} /> : null}
          </section>
        ) : null}
        <SaveError error={save.error} />
      </Modal>
      {existing ? (
        <ConfirmDialog
          open={confirmDelete}
          title={t('settings.importLists.importListEditor.deleteName', { name: existing.name })}
          confirmLabel={t('settings.importLists.importListEditor.deleteImportList')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(existing.id);
            onClose();
          }}
        >
          {t('settings.importLists.importListEditor.theListStopsSyncingTitles')}
        </ConfirmDialog>
      ) : null}
    </>
  );
}
