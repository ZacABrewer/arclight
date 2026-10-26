import { useMemo, useState } from 'react';
import type { ImportList, ImportListMediaType, ImportListSchema, ImportListTestResult, TraktPollResponse } from '@arclight/shared';
import { importListsApi } from '../../../api/import-lists.js';
import { errorMessage } from '../../../api/client.js';
import { Button, Modal } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm, useSchemaForm } from '../../../components/forms/schema-form.js';
import { TestResultView } from '../../../components/forms/test-result.js';
import type { FormValues } from '../../../components/forms/types.js';
import { getPath, setPath } from '../../../components/forms/values.js';
import { useDeleteImportList, useSaveImportList } from '../../../hooks/import-lists.js';
import { EditorFooter, SaveError } from '../shared.js';
import { existingListValues, listFields, newListValues, rootsFor, settingsFields, toListBody, type RootFolderOption } from './fields.js';
import { ItemsTable } from './items-table.js';
import { TraktAuth } from './trakt-auth.js';

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
  const settings = useMemo(() => settingsFields(schema), [schema]);
  const fields = useMemo(
    () => [...listFields({ schema, mediaType, rootFolders, profiles }), ...settings.fields],
    [schema, mediaType, rootFolders, profiles, settings.fields],
  );
  const form = useSchemaForm(fields, base);
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

  const authorized = (res: TraktPollResponse) => {
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
  const title = existing ? `Edit ${existing.name}` : `Add ${schema?.implementationName ?? 'import list'}`;

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
              <Button variant="secondary" loading={testing} onClick={() => void runTest()}>
                Test
              </Button>
            }
          />
        }
      >
        {schema?.infoLink ? (
          <p className="al-caption">
            <a href={schema.infoLink} target="_blank" rel="noreferrer">
              About {schema.implementationName}
            </a>
          </p>
        ) : null}
        <SchemaForm fields={fields} values={form.values} errors={form.errors} onChange={change} renderers={settings.renderers} />
        {schema?.requiresTraktAuth ? (
          <TraktAuth
            clientId={typeof clientId === 'string' ? clientId : ''}
            clientSecret={typeof clientSecret === 'string' ? clientSecret : undefined}
            importListId={existing?.id}
            onAuthorized={authorized}
          />
        ) : null}
        {test ? (
          <section aria-label="Test result">
            <TestResultView
              outcome={{
                ok: test.ok,
                message: test.ok ? `${test.itemCount ?? test.items?.length ?? 0} items found` : undefined,
                warnings: [],
                errors: test.error ? [test.error.message] : [],
              }}
            />
            {test.ok && test.items?.length ? <ItemsTable caption="First items" items={test.items} /> : null}
          </section>
        ) : null}
        <SaveError error={save.error} />
      </Modal>
      {existing ? (
        <ConfirmDialog
          open={confirmDelete}
          title={`Delete ${existing.name}?`}
          confirmLabel="Delete import list"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(existing.id);
            onClose();
          }}
        >
          The list stops syncing. Titles it already added stay in the library.
        </ConfirmDialog>
      ) : null}
    </>
  );
}
