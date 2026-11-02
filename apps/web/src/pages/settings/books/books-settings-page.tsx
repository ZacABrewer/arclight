import { useState } from 'react';
import {
  BooksLibraryAppImplementation,
  formatsOfKind,
  type BooksFormatProfile,
  type BooksFormatProfileInput,
  type BooksKind,
  type BooksLibraryApp,
  type BooksLibraryAppInput,
  type BooksLibraryAppKind,
  type BooksSettings,
} from '@arclight/shared';
import { ApiError, errorMessage } from '../../../api/client.js';
import { Button, Checkbox, Chip, ErrorBlock, FormRow, Input, Modal, Segmented, Select, Skeleton, Textarea, Toggle } from '../../../arclight/index.js';
import { SchemaForm } from '../../../components/forms/schema-form.js';
import type { FieldDefinition, FieldRendererProps, FieldRenderers, FormValues } from '../../../components/forms/types.js';
import { useToast } from '../../../components/toast.js';
import {
  useBooksFormatProfiles,
  useBooksLibraryApps,
  useBooksSettings,
  useDeleteBooksFormatProfile,
  useDeleteBooksLibraryApp,
  useSaveBooksFormatProfile,
  useSaveBooksLibraryApp,
  useSaveBooksSettings,
  useTestBooksLibraryApp,
} from '../../../hooks/books.js';
import { BooksGate, FormatBadge } from '../../library/books/books-kit.js';
import { COMIC_NAMING_TOKENS, EBOOK_NAMING_TOKENS, formatLabel, moveItem, parseCategories, parseLanguages, parseSizeMb, parseTerms, toggleFormat } from '../../library/books/books-model.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { AddCard, CardGrid, EditorFooter, ItemCard, PendingApiNotice, SaveError, SettingsSection } from '../shared.js';
import '../../library/books/books.css';
import { t } from '../../../i18n/index.js';

const METADATA_FIELDS = (): FieldDefinition[] => [
  { name: 'metadata.openLibrary', label: t('books.source.openLibrary'), type: 'checkbox', helpText: t('books.settings.openLibraryHelp') },
  { name: 'metadata.googleBooks', label: t('books.source.googleBooks'), type: 'checkbox' },
  { name: 'metadata.googleBooksApiKey', label: t('books.settings.googleBooksApiKey'), type: 'password', helpText: t('books.settings.googleBooksApiKeyHelp') },
  { name: 'metadata.hardcover', label: t('books.source.hardcover'), type: 'checkbox' },
  { name: 'metadata.hardcoverApiKey', label: t('books.settings.hardcoverApiKey'), type: 'password', helpText: t('books.settings.hardcoverApiKeyHelp') },
  { name: 'metadata.comicVine', label: t('books.source.comicVine'), type: 'checkbox' },
  { name: 'metadata.comicVineApiKey', label: t('books.settings.comicVineApiKey'), type: 'password' },
  { name: 'metadata.metron', label: t('books.source.metron'), type: 'checkbox' },
  { name: 'metadata.metronUsername', label: t('books.settings.metronUsername'), type: 'text' },
  { name: 'metadata.metronPassword', label: t('books.settings.metronPassword'), type: 'password' },
  { name: 'metadata.languages', label: t('books.settings.languages'), type: 'text', helpText: t('books.settings.languagesHelp') },
];

const NAMING_FIELDS = (): FieldDefinition[] => [
  { name: 'naming.renameFiles', label: t('books.settings.renameFiles'), type: 'checkbox' },
  { name: 'naming.ebookFolderFormat', label: t('books.settings.ebookFolderFormat'), type: 'text' },
  { name: 'naming.ebookFileFormat', label: t('books.settings.ebookFileFormat'), type: 'text' },
  { name: 'naming.comicFolderFormat', label: t('books.settings.comicFolderFormat'), type: 'text' },
  { name: 'naming.comicFileFormat', label: t('books.settings.comicFileFormat'), type: 'text' },
];

const SEARCH_FIELDS = (): FieldDefinition[] => [
  { name: 'search.ebookCategories', label: t('books.settings.ebookCategories'), type: 'text', helpText: t('books.settings.categoriesHelp') },
  { name: 'search.comicCategories', label: t('books.settings.comicCategories'), type: 'text', helpText: t('books.settings.categoriesHelp') },
  { name: 'search.missingSearchIntervalHours', label: t('books.settings.missingSearchInterval'), type: 'number', min: 0, max: 168, unit: 'h', helpText: t('books.settings.missingSearchIntervalHelp') },
  { name: 'search.itemSearchCooldownHours', label: t('books.settings.itemSearchCooldown'), type: 'number', min: 0, max: 720, unit: 'h', helpText: t('books.settings.itemSearchCooldownHelp') },
];

/** A list field typed as text ("en, de" / "7020, 7000"), committed on blur so commas can be typed. */
function listRenderer(parse: (text: string) => Array<string | number>) {
  return function ListField({ id, value, onChange }: FieldRendererProps) {
    const joined = Array.isArray(value) ? value.join(', ') : '';
    const [text, setText] = useState(joined);
    const [last, setLast] = useState(joined);
    if (joined !== last) {
      setLast(joined);
      setText(joined);
    }
    return <Input id={id} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(parse(text))} />;
  };
}

const RENDERERS: FieldRenderers = {
  'metadata.languages': listRenderer(parseLanguages),
  'search.ebookCategories': listRenderer(parseCategories),
  'search.comicCategories': listRenderer(parseCategories),
};

export function BooksSettingsPage() {
  return (
    <BooksGate>
      <SettingsView />
    </BooksGate>
  );
}

function SettingsView() {
  const settings = useBooksSettings();
  const save = useSaveBooksSettings();
  const toast = useToast();
  const draft = useDraft<BooksSettings | null>(settings.data ?? null);
  const pending = settings.error instanceof ApiError && settings.error.status === 404;
  const value = draft.value;
  const values = value as unknown as FormValues;
  const onChange = (next: FormValues) => draft.set(next as unknown as BooksSettings);
  const onSave = () => {
    if (!value) return;
    save.mutate(value, { onSuccess: () => toast.push({ tone: 'ok', title: t('books.settings.saved') }) });
  };

  return (
    <SettingsPage
      title={t('books.title')}
      description={t('books.settings.description')}
      save={{ count: draft.changes, onSave, onDiscard: draft.discard, saving: save.isPending }}
    >
      {settings.isPending ? (
        <Skeleton lines={6} />
      ) : pending ? (
        <PendingApiNotice what={t('books.settings.what')} />
      ) : settings.isError ? (
        <ErrorBlock title={t('books.settings.couldNotLoad')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : value ? (
        <>
          <SettingsSection label={t('books.settings.metadata')}>
            <SchemaForm fields={METADATA_FIELDS()} values={values} onChange={onChange} renderers={RENDERERS} inline />
          </SettingsSection>
          <SettingsSection label={t('books.settings.naming')}>
            <SchemaForm fields={NAMING_FIELDS()} values={values} onChange={onChange} inline />
            <TokenList label={t('books.settings.ebookTokens')} tokens={EBOOK_NAMING_TOKENS} />
            <TokenList label={t('books.settings.comicTokens')} tokens={COMIC_NAMING_TOKENS} />
          </SettingsSection>
          <SettingsSection label={t('books.settings.search')}>
            <SchemaForm fields={SEARCH_FIELDS()} values={values} onChange={onChange} renderers={RENDERERS} inline />
          </SettingsSection>
        </>
      ) : null}
      <FormatProfilesSection />
      <LibraryAppsSection />
    </SettingsPage>
  );
}

function TokenList({ label, tokens }: { label: string; tokens: readonly string[] }) {
  return (
    <div className="bk-tokens" aria-label={label}>
      <span className="mk-muted">{label}</span>
      {tokens.map((tok) => (
        <code key={tok}>{tok}</code>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Format profiles
// ---------------------------------------------------------------------------------------

function newProfile(kind: BooksKind): BooksFormatProfileInput {
  const formats = [...formatsOfKind(kind)];
  return { name: '', kind, formats, cutoff: formats[0]!, upgradeAllowed: true, minSizeMb: null, maxSizeMb: null, ignoredTerms: [], preferredTerms: [] };
}

function FormatProfilesSection() {
  const profiles = useBooksFormatProfiles();
  const [editing, setEditing] = useState<{ id: number | null; body: BooksFormatProfileInput } | null>(null);
  return (
    <SettingsSection label={t('books.settings.formatProfiles')} count={profiles.data?.length}>
      {profiles.isPending ? (
        <Skeleton lines={3} />
      ) : profiles.isError ? (
        <ErrorBlock title={t('books.couldNotLoad')} onRetry={() => void profiles.refetch()}>
          {errorMessage(profiles.error)}
        </ErrorBlock>
      ) : (
        <CardGrid label={t('books.settings.formatProfiles')}>
          {profiles.data.map((p) => (
            <ItemCard
              key={p.id}
              title={p.name}
              onClick={() => setEditing({ id: p.id, body: { ...p } })}
              status={
                <Chip tone="neutral" dot="none">
                  {p.kind === 'ebook' ? t('books.kind.ebook') : t('books.kind.comic')}
                </Chip>
              }
            >
              <span className="bk-tokens">
                {p.formats.map((f) => (
                  <FormatBadge key={f} format={f} />
                ))}
              </span>
              <span className="mk-muted">{t('books.settings.cutoffIs', { format: formatLabel(p.cutoff) })}</span>
            </ItemCard>
          ))}
          <AddCard label={t('books.settings.addProfile')} onClick={() => setEditing({ id: null, body: newProfile('ebook') })} />
        </CardGrid>
      )}
      {editing ? <ProfileEditor initial={editing} onClose={() => setEditing(null)} /> : null}
    </SettingsSection>
  );
}

function ProfileEditor({ initial, onClose }: { initial: { id: number | null; body: BooksFormatProfileInput }; onClose: () => void }) {
  const save = useSaveBooksFormatProfile();
  const del = useDeleteBooksFormatProfile();
  const [p, setP] = useState<BooksFormatProfileInput>(initial.body);
  const [minText, setMinText] = useState(p.minSizeMb == null ? '' : String(p.minSizeMb));
  const [maxText, setMaxText] = useState(p.maxSizeMb == null ? '' : String(p.maxSizeMb));
  const [ignored, setIgnored] = useState((p.ignoredTerms ?? []).join('\n'));
  const [preferred, setPreferred] = useState((p.preferredTerms ?? []).join('\n'));
  const [error, setError] = useState<string | null>(null);
  const all = formatsOfKind(p.kind);
  // Accepted formats first (in order), then the rest unticked.
  const order = [...p.formats, ...all.filter((f) => !p.formats.includes(f))];

  const onSave = () => {
    const minSizeMb = parseSizeMb(minText);
    const maxSizeMb = parseSizeMb(maxText);
    if (!p.name.trim()) return setError(t('books.settings.nameRequired'));
    if (p.formats.length === 0) return setError(t('books.settings.formatRequired'));
    if (minSizeMb === undefined || maxSizeMb === undefined) return setError(t('books.settings.sizeInvalid'));
    if (minSizeMb !== null && maxSizeMb !== null && minSizeMb > maxSizeMb) return setError(t('books.settings.sizeOrder'));
    setError(null);
    save.mutate(
      { id: initial.id, body: { ...p, name: p.name.trim(), minSizeMb, maxSizeMb, ignoredTerms: parseTerms(ignored), preferredTerms: parseTerms(preferred) } },
      { onSuccess: onClose },
    );
  };

  const onDelete =
    initial.id === null
      ? undefined
      : () =>
          del.mutate(initial.id!, {
            onSuccess: onClose,
            onError: (e) => setError(e instanceof ApiError && e.status === 409 ? t('books.settings.profileInUse') : errorMessage(e)),
          });

  return (
    <Modal
      open
      onClose={onClose}
      title={initial.id === null ? t('books.settings.addProfile') : t('books.settings.editProfile', { name: initial.body.name })}
      size={560}
      footer={<EditorFooter onCancel={onClose} onSave={onSave} saving={save.isPending} onDelete={onDelete} />}
    >
      <div className="mk-stack-sm">
        <FormRow label={t('common.name')} htmlFor="bfp-name">
          <Input id="bfp-name" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
        </FormRow>
        {initial.id === null ? (
          <FormRow label={t('books.kindLabel')}>
            <Segmented
              aria-label={t('books.kindLabel')}
              variant="soft"
              value={p.kind}
              onChange={(kind) => setP({ ...newProfile(kind), name: p.name })}
              options={[
                { value: 'ebook' as const, label: t('books.kind.ebook') },
                { value: 'comic' as const, label: t('books.kind.comic') },
              ]}
            />
          </FormRow>
        ) : null}
        <FormRow label={t('books.settings.formats')} caption={t('books.settings.formatsCaption')}>
          <ol className="bk-format-list">
            {order.map((f) => {
              const on = p.formats.includes(f);
              const index = p.formats.indexOf(f);
              return (
                <li key={f} data-off={on ? undefined : ''}>
                  <Checkbox aria-label={formatLabel(f)} checked={on} onChange={() => setP({ ...p, ...toggleFormat(p.formats, p.cutoff, f) })} />
                  <span className="bk-format-list__name">{formatLabel(f)}</span>
                  {on ? (
                    <span className="bk-format-list__moves">
                      <Button size="sm" variant="ghost" disabled={index === 0} aria-label={t('books.settings.moveUp', { format: formatLabel(f) })} onClick={() => setP({ ...p, formats: moveItem(p.formats, index, -1) })}>
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={index === p.formats.length - 1}
                        aria-label={t('books.settings.moveDown', { format: formatLabel(f) })}
                        onClick={() => setP({ ...p, formats: moveItem(p.formats, index, 1) })}
                      >
                        ↓
                      </Button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </FormRow>
        <FormRow label={t('books.settings.cutoff')} htmlFor="bfp-cutoff" caption={t('books.settings.cutoffCaption')}>
          <Select id="bfp-cutoff" value={p.cutoff} onChange={(e) => setP({ ...p, cutoff: e.target.value as BooksFormatProfile['cutoff'] })} options={p.formats.map((f) => ({ value: f, label: formatLabel(f) }))} />
        </FormRow>
        <FormRow label={t('books.settings.upgradeAllowed')} htmlFor="bfp-upgrade" captionInline>
          <Toggle id="bfp-upgrade" checked={p.upgradeAllowed ?? true} onChange={(e) => setP({ ...p, upgradeAllowed: e.target.checked })} />
        </FormRow>
        <FormRow label={t('books.settings.minSize')} htmlFor="bfp-min" caption={t('books.settings.sizeCaption')}>
          <Input id="bfp-min" inputMode="decimal" value={minText} onChange={(e) => setMinText(e.target.value)} />
        </FormRow>
        <FormRow label={t('books.settings.maxSize')} htmlFor="bfp-max" caption={t('books.settings.sizeCaption')}>
          <Input id="bfp-max" inputMode="decimal" value={maxText} onChange={(e) => setMaxText(e.target.value)} />
        </FormRow>
        <FormRow label={t('books.settings.ignoredTerms')} htmlFor="bfp-ignored" caption={t('books.settings.termsCaption')}>
          <Textarea id="bfp-ignored" rows={3} value={ignored} onChange={(e) => setIgnored(e.target.value)} />
        </FormRow>
        <FormRow label={t('books.settings.preferredTerms')} htmlFor="bfp-preferred" caption={t('books.settings.termsCaption')}>
          <Textarea id="bfp-preferred" rows={3} value={preferred} onChange={(e) => setPreferred(e.target.value)} />
        </FormRow>
        {error ? (
          <p className="al-inline-error" role="alert">
            {error}
          </p>
        ) : (
          <SaveError error={save.error} />
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------
// Library apps
// ---------------------------------------------------------------------------------------

const APP_KINDS: readonly BooksLibraryAppKind[] = ['ebook', 'comic', 'audiobook'];

export function libraryAppLabel(impl: BooksLibraryApp['implementation']): string {
  switch (impl) {
    case 'calibreWeb':
      return t('books.apps.calibreWeb');
    case 'kavita':
      return t('books.apps.kavita');
    case 'komga':
      return t('books.apps.komga');
    case 'audiobookshelf':
      return t('books.apps.audiobookshelf');
  }
}

function appKindLabel(kind: BooksLibraryAppKind): string {
  return kind === 'ebook' ? t('books.kind.ebooks') : kind === 'comic' ? t('books.kind.comics') : t('common.audiobooks');
}

/** Which credential fields an app uses: Calibre-Web signs in, the others take an API key. */
export function appUsesLogin(impl: BooksLibraryApp['implementation']): boolean {
  return impl === 'calibreWeb';
}

function newApp(): BooksLibraryAppInput {
  return { name: '', implementation: 'kavita', enabled: true, url: 'http://localhost:5000', apiKey: '', username: '', password: '', libraryId: '', kinds: ['ebook', 'comic'] };
}

function LibraryAppsSection() {
  const apps = useBooksLibraryApps();
  const [editing, setEditing] = useState<{ id: number | null; body: BooksLibraryAppInput } | null>(null);
  return (
    <SettingsSection label={t('books.settings.libraryApps')} count={apps.data?.length}>
      <p className="al-caption">{t('books.settings.libraryAppsCaption')}</p>
      {apps.isPending ? (
        <Skeleton lines={3} />
      ) : apps.isError ? (
        <ErrorBlock title={t('books.couldNotLoad')} onRetry={() => void apps.refetch()}>
          {errorMessage(apps.error)}
        </ErrorBlock>
      ) : (
        <CardGrid label={t('books.settings.libraryApps')}>
          {apps.data.map((a) => (
            <ItemCard
              key={a.id}
              title={a.name}
              muted={!a.enabled}
              onClick={() => setEditing({ id: a.id, body: { ...a } })}
              status={
                <Chip tone={a.enabled ? 'accent' : 'muted'} dot={a.enabled ? 'fill' : 'ring'}>
                  {libraryAppLabel(a.implementation)}
                </Chip>
              }
            >
              <span className="mk-muted">{a.kinds.map(appKindLabel).join(', ')}</span>
            </ItemCard>
          ))}
          <AddCard label={t('books.settings.addApp')} onClick={() => setEditing({ id: null, body: newApp() })} />
        </CardGrid>
      )}
      {editing ? <AppEditor initial={editing} onClose={() => setEditing(null)} /> : null}
    </SettingsSection>
  );
}

function AppEditor({ initial, onClose }: { initial: { id: number | null; body: BooksLibraryAppInput }; onClose: () => void }) {
  const save = useSaveBooksLibraryApp();
  const del = useDeleteBooksLibraryApp();
  const test = useTestBooksLibraryApp();
  const [a, setA] = useState<BooksLibraryAppInput>(initial.body);
  const [error, setError] = useState<string | null>(null);
  const login = appUsesLogin(a.implementation);
  const kinds = a.kinds;

  const validate = (): boolean => {
    if (!a.name.trim()) return (setError(t('books.settings.nameRequired')), false);
    if (!/^https?:\/\/\S+$/i.test(a.url.trim())) return (setError(t('books.settings.urlInvalid')), false);
    if (kinds.length === 0) return (setError(t('books.settings.kindRequired')), false);
    setError(null);
    return true;
  };
  const body = (): BooksLibraryAppInput => ({ ...a, name: a.name.trim(), url: a.url.trim() });

  return (
    <Modal
      open
      onClose={onClose}
      title={initial.id === null ? t('books.settings.addApp') : t('books.settings.editApp', { name: initial.body.name })}
      size={560}
      footer={
        <EditorFooter
          onCancel={onClose}
          onSave={() => validate() && save.mutate({ id: initial.id, body: body() }, { onSuccess: onClose })}
          saving={save.isPending}
          onDelete={initial.id === null ? undefined : () => del.mutate(initial.id!, { onSuccess: onClose })}
          extra={
            <Button loading={test.isPending} onClick={() => validate() && test.mutate({ ...body(), ...(initial.id !== null ? { id: initial.id } : {}) })}>
              {t('common.test')}
            </Button>
          }
        />
      }
    >
      <div className="mk-stack-sm">
        <FormRow label={t('common.name')} htmlFor="bla-name">
          <Input id="bla-name" value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} />
        </FormRow>
        <FormRow label={t('books.settings.app')} htmlFor="bla-impl">
          <Select
            id="bla-impl"
            value={a.implementation}
            onChange={(e) => setA({ ...a, implementation: e.target.value as BooksLibraryApp['implementation'] })}
            options={BooksLibraryAppImplementation.options.map((v) => ({ value: v, label: libraryAppLabel(v) }))}
          />
        </FormRow>
        <FormRow label={t('common.enabled')} htmlFor="bla-enabled" captionInline>
          <Toggle id="bla-enabled" checked={a.enabled ?? true} onChange={(e) => setA({ ...a, enabled: e.target.checked })} />
        </FormRow>
        <FormRow label={t('books.settings.url')} htmlFor="bla-url" caption={t('books.settings.urlCaption')}>
          <Input id="bla-url" type="url" value={a.url} onChange={(e) => setA({ ...a, url: e.target.value })} />
        </FormRow>
        {login ? (
          <>
            <FormRow label={t('common.username')} htmlFor="bla-user">
              <Input id="bla-user" autoComplete="off" value={a.username ?? ''} onChange={(e) => setA({ ...a, username: e.target.value })} />
            </FormRow>
            <FormRow label={t('common.password')} htmlFor="bla-pass" caption={t('books.settings.secretCaption')}>
              <Input id="bla-pass" type="password" autoComplete="new-password" value={a.password ?? ''} onChange={(e) => setA({ ...a, password: e.target.value })} />
            </FormRow>
          </>
        ) : (
          <FormRow label={t('common.apiKey')} htmlFor="bla-key" caption={t('books.settings.secretCaption')}>
            <Input id="bla-key" type="password" autoComplete="off" value={a.apiKey ?? ''} onChange={(e) => setA({ ...a, apiKey: e.target.value })} />
          </FormRow>
        )}
        <FormRow label={t('books.settings.libraryId')} htmlFor="bla-lib" caption={t('books.settings.libraryIdCaption')}>
          <Input id="bla-lib" value={a.libraryId ?? ''} onChange={(e) => setA({ ...a, libraryId: e.target.value })} />
        </FormRow>
        <FormRow label={t('books.settings.appKinds')}>
          <div className="mk-row">
            {APP_KINDS.map((k) => (
              <Checkbox
                key={k}
                label={appKindLabel(k)}
                checked={kinds.includes(k)}
                onChange={() => setA({ ...a, kinds: kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k] })}
              />
            ))}
          </div>
        </FormRow>
        {test.data ? (
          <p className={test.data.ok ? 'mk-muted' : 'al-inline-error'} role="status">
            {test.data.ok ? t('books.settings.testOk') : t('books.settings.testFailed')} {test.data.message}
          </p>
        ) : test.error ? (
          <p className="al-inline-error" role="alert">
            {errorMessage(test.error)}
          </p>
        ) : null}
        {error ? (
          <p className="al-inline-error" role="alert">
            {error}
          </p>
        ) : (
          <SaveError error={save.error} />
        )}
      </div>
    </Modal>
  );
}
