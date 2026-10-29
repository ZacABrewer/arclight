import { useId, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { AddBookRequestInput, BookSearchResult, MonitorNewBooks, QualityProfile, RootFolder } from '@arclight/shared';
import type { BookLookupInput } from '../../../api/audiobooks.js';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, EmptyState, ErrorBlock, FormRow, Modal, Select, Toggle, buttonClass } from '../../../arclight/index.js';
import { Loading } from '../../../components/media/media-kit.js';
import { TagPicker } from '../../../components/media/tag-picker.js';
import { useToast } from '../../../components/toast.js';
import { useAddBook, useBookLookup } from '../../../hooks/audiobooks.js';
import { BookCoverArt, FormatTypeChip, bookLink } from './audiobook-kit.js';
import { NEW_BOOK_OPTIONS, authorFolder, formatRuntime, monitorNewBooksLabel, positionLabel } from './audiobook-model.js';
import { TargetFields, useAudiobookAddTarget, useTargetState } from './add-shared.js';
import '../library.css';
import { t } from '../../../i18n/index.js';

/** What the book search box searches: anything, a title, an author, or an exact ASIN / ISBN. */
export type BookSearchField = 'any' | 'title' | 'author' | 'asin' | 'isbn';
export const BOOK_SEARCH_FIELDS: readonly BookSearchField[] = ['any', 'title', 'author', 'asin', 'isbn'];
export const bookSearchFieldLabel = (field: BookSearchField) => t('audiobooks.add.searchField', { field });

const ASIN_RE = /^[0-9a-z]{10}$/i;
const ISBN_RE = /^(?:\d{9}[\dX]|\d{13})$/i;

/**
 * The GET /book/lookup query for a field and term. In `any` mode an ISBN (hyphens allowed) or an
 * ASIN-looking code (B0…) is sent as such, so pasting one just works.
 */
export function bookLookupInput(field: BookSearchField, term: string): BookLookupInput {
  const v = term.trim();
  if (!v) return {};
  const digits = v.replace(/[\s-]/g, '');
  switch (field) {
    case 'title':
      return { title: v };
    case 'author':
      return { author: v };
    case 'asin':
      return { asin: v.toUpperCase() };
    case 'isbn':
      return { isbn: digits.toUpperCase() };
    case 'any':
      if (ISBN_RE.test(digits) && /\d{9}/.test(digits)) return { isbn: digits.toUpperCase() };
      if (ASIN_RE.test(v) && /^B0/i.test(v)) return { asin: v.toUpperCase() };
      return { term: v };
  }
}

/** "Narrated by X · 11 h 24 min · 2015" for a result. */
export function bookResultMeta(r: Pick<BookSearchResult, 'narrators' | 'runtimeMinutes' | 'year' | 'publisher'>): string {
  return [
    r.narrators.length ? t('audiobooks.add.narratedByNames', { names: r.narrators.join(', ') }) : null,
    r.runtimeMinutes ? formatRuntime(r.runtimeMinutes) : null,
    r.year ? String(r.year) : null,
    r.publisher ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const resultKey = (r: BookSearchResult) => r.asin ?? r.isbn13 ?? r.olWorkId ?? `${r.title}-${r.authors.map((a) => a.name).join(',')}`;

export function AddBookResults({ term, field }: { term: string; field: BookSearchField }) {
  const input = bookLookupInput(field, term);
  const search = useBookLookup(input);
  const [adding, setAdding] = useState<BookSearchResult | null>(null);
  const active = Object.values(input).some((v) => typeof v === 'string' && v.length >= 2);

  return (
    <>
      {!active ? (
        <EmptyState title={t('audiobooks.add.typeABook')}>{t('audiobooks.add.resultsComeFromTheCatalogue')}</EmptyState>
      ) : search.isError ? (
        <ErrorBlock title={t('audiobooks.add.searchFailed')} onRetry={() => void search.refetch()} retryLabel={t('library.addNew.tryAgain')}>
          {errorMessage(search.error)}
        </ErrorBlock>
      ) : search.isPending ? (
        <Loading label={t('library.addNew.searching')} />
      ) : search.data.length === 0 ? (
        <EmptyState title={t('library.addNew.noResultsForDebounced', { debounced: term.trim() })}>{t('library.addNew.checkTheSpellingOrTry')}</EmptyState>
      ) : (
        <div role="list" aria-label={t('common.searchResults')}>
          {search.data.map((r) => (
            <BookResultRow key={resultKey(r)} result={r} onAdd={() => setAdding(r)} />
          ))}
        </div>
      )}
      <AddBookDialog result={adding} onClose={() => setAdding(null)} />
    </>
  );
}

function BookResultRow({ result, onAdd }: { result: BookSearchResult; onAdd: () => void }) {
  const series = result.series[0];
  const addable = Boolean(result.asin || result.isbn13);
  return (
    <article className="mk-result" role="listitem" aria-label={result.title}>
      <BookCoverArt book={result} />
      <div style={{ minWidth: 0 }}>
        <h2 className="mk-result__title">
          {result.title}
          {result.bookId != null ? <Chip tone="accent">{t('common.inLibrary')}</Chip> : null}
          <FormatTypeChip type={result.formatType} />
        </h2>
        <div className="music-result__meta">{result.authors.map((a) => a.name).join(', ')}</div>
        {series ? <div className="ab-book__position">{[series.name, positionLabel(series.position)].filter(Boolean).join(' · ')}</div> : null}
        <div className="mk-result__meta">{bookResultMeta(result)}</div>
      </div>
      <div>
        {result.bookId != null ? (
          <Link className={buttonClass({ variant: 'ghost', size: 'sm' })} {...bookLink({ id: result.bookId })}>
            {t('common.open')}
          </Link>
        ) : (
          <Button size="sm" variant="secondary" disabled={!addable} aria-label={t('library.addNew.addTitle', { title: result.title })} onClick={onAdd}>
            {t('common.add')}
          </Button>
        )}
      </div>
    </article>
  );
}

export function AddBookDialog({ result, onClose }: { result: BookSearchResult | null; onClose: () => void }) {
  const { roots, profiles } = useAudiobookAddTarget(result !== null && result.authorId == null);
  return (
    <Modal open={result !== null} onClose={onClose} title={result ? t('library.addDialog.addTitle', { title: result.title }) : t('common.add')} size={560}>
      {result ? <AddBookForm key={resultKey(result)} result={result} onClose={onClose} roots={roots} profiles={profiles} /> : null}
    </Modal>
  );
}

function AddBookForm({ result, onClose, roots, profiles }: { result: BookSearchResult; onClose: () => void; roots: RootFolder[]; profiles: QualityProfile[] }) {
  // A book whose author is not in the library creates the author too: then a root folder and a profile are needed.
  const newAuthor = result.authorId == null;
  const { target, setTarget, errors, valid, remember } = useTargetState(roots, profiles);
  const [monitored, setMonitored] = useState(true);
  const [monitorNewBooks, setMonitorNewBooks] = useState<MonitorNewBooks>('none');
  const [tags, setTags] = useState<number[]>([]);
  const [searchOnAdd, setSearchOnAdd] = useState(false);
  const [touched, setTouched] = useState(false);
  const add = useAddBook();
  const toast = useToast();
  const navigate = useNavigate();
  const ids = useId();
  const fid = (k: string) => `${ids}-${k}`;
  const authorName = result.authors[0]?.name ?? '';

  const submit = () => {
    setTouched(true);
    if (newAuthor && (!valid || target.qualityProfileId === null)) return;
    const body: AddBookRequestInput = {
      ...(result.asin ? { asin: result.asin } : result.isbn13 ? { isbn: result.isbn13 } : {}),
      ...(result.region ? { region: result.region } : {}),
      monitored,
      searchOnAdd,
    };
    if (newAuthor && target.qualityProfileId !== null) {
      remember();
      body.author = { rootFolderPath: target.rootFolderPath, qualityProfileId: target.qualityProfileId, monitored: true, monitorNewBooks, tags };
    }
    add.mutate(body, {
      onSuccess: (book) => {
        toast.push({ tone: 'ok', title: t('library.addDialog.addedTitle', { title: book.title }) });
        onClose();
        void navigate(bookLink(book));
      },
    });
  };

  return (
    <form
      className="mk-stack-sm"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="lib-add-head">
        <BookCoverArt book={result} />
        <div style={{ minWidth: 0 }}>
          <div className="mk-result__title">{result.title}</div>
          <div className="mk-result__meta">{result.authors.map((a) => a.name).join(', ')}</div>
          <div className="mk-result__meta">{bookResultMeta(result)}</div>
        </div>
      </div>

      <FormRow label={t('status.monitored')} htmlFor={fid('monitored')} captionInline caption={t('audiobooks.add.monitorBookCaption')}>
        <Toggle id={fid('monitored')} checked={monitored} onChange={(e) => setMonitored(e.currentTarget.checked)} />
      </FormRow>

      {newAuthor ? (
        <section className="mk-stack-sm" aria-label={t('audiobooks.add.newAuthor')} data-testid="new-author-options">
          <p className="al-caption" style={{ margin: 0 }}>
            {t('audiobooks.add.authorNotInLibrary', { name: authorName })}
          </p>
          <TargetFields idPrefix={ids} target={target} onChange={setTarget} roots={roots} profiles={profiles} errors={errors} touched={touched} />
          <FormRow label={t('audiobooks.monitorNewBooksLabel')} htmlFor={fid('new')}>
            <Select id={fid('new')} value={monitorNewBooks} onChange={(e) => setMonitorNewBooks(e.target.value as MonitorNewBooks)}>
              {NEW_BOOK_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {monitorNewBooksLabel(v)}
                </option>
              ))}
            </Select>
          </FormRow>
          <FormRow label={t('common.tags')}>
            <TagPicker value={tags} onChange={setTags} />
          </FormRow>
          <FormRow label={t('library.addDialog.destination')}>
            <div className="lib-path-preview" data-testid="path-preview">
              {authorFolder(target.rootFolderPath, authorName) || t('library.addDialog.chooseARootFolderTo')}
            </div>
          </FormRow>
        </section>
      ) : null}

      <FormRow label={t('common.searchOnAdd')} htmlFor={fid('search')} captionInline caption={t('audiobooks.add.searchBookOnAddCaption')}>
        <Toggle id={fid('search')} checked={searchOnAdd} onChange={(e) => setSearchOnAdd(e.currentTarget.checked)} />
      </FormRow>

      {add.isError ? (
        <p className="al-field__error" role="alert" style={{ margin: 0 }}>
          {errorMessage(add.error)}
        </p>
      ) : null}

      <div className="lib-form-foot">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={add.isPending} disabled={newAuthor && (target.qualityProfileId === null || (touched && !valid))}>
          {t('audiobooks.addBook')}
        </Button>
      </div>
    </form>
  );
}
