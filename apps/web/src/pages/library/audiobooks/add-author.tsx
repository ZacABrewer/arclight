import { useId, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { AudiobookMonitorOption, AuthorSearchResult, MonitorNewBooks, QualityProfile, RootFolder } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, EmptyState, ErrorBlock, FormRow, Modal, Select, Toggle, buttonClass } from '../../../arclight/index.js';
import { Loading } from '../../../components/media/media-kit.js';
import { TagPicker } from '../../../components/media/tag-picker.js';
import { useToast } from '../../../components/toast.js';
import { useAddAuthor, useAuthorLookup } from '../../../hooks/audiobooks.js';
import { AuthorArt, authorLink } from './audiobook-kit.js';
import { MONITOR_OPTIONS, NEW_BOOK_OPTIONS, authorFolder, monitorNewBooksLabel, monitorOptionLabel } from './audiobook-model.js';
import { TargetFields, useAudiobookAddTarget, useTargetState } from './add-shared.js';
import '../library.css';
import { t } from '../../../i18n/index.js';

/** "12 books · Known for A, B" for a search result. */
export function authorResultMeta(r: Pick<AuthorSearchResult, 'bookCount' | 'topBooks'>): string {
  const parts = [
    r.bookCount != null ? t('audiobooks.bookCount', { count: r.bookCount }) : null,
    r.topBooks.length ? t('audiobooks.add.knownFor', { titles: r.topBooks.slice(0, 3).join(', ') }) : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Author results of the Audiobooks tab: search the catalogue for `term`, then add with a root folder, profile and monitoring. */
export function AddAuthorResults({ term }: { term: string }) {
  const search = useAuthorLookup(term);
  const [adding, setAdding] = useState<AuthorSearchResult | null>(null);
  const active = term.trim().length >= 2;

  return (
    <>
      {!active ? (
        <EmptyState title={t('audiobooks.add.typeAnAuthor')}>{t('audiobooks.add.resultsComeFromTheCatalogue')}</EmptyState>
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
            <AuthorResultRow key={r.asin ?? r.olAuthorId ?? r.name} result={r} onAdd={() => setAdding(r)} />
          ))}
        </div>
      )}
      <AddAuthorDialog result={adding} onClose={() => setAdding(null)} />
    </>
  );
}

function AuthorResultRow({ result, onAdd }: { result: AuthorSearchResult; onAdd: () => void }) {
  const meta = authorResultMeta(result);
  return (
    <article className="mk-result" role="listitem" aria-label={result.name}>
      <AuthorArt author={result} />
      <div style={{ minWidth: 0 }}>
        <h2 className="mk-result__title">
          {result.name}
          {result.authorId != null ? <Chip tone="accent">{t('common.inLibrary')}</Chip> : null}
        </h2>
        {meta ? <div className="music-result__meta">{meta}</div> : null}
        {result.genres.length ? (
          <div className="music-result__genres">
            {result.genres.slice(0, 5).map((g) => (
              <Chip key={g} tone="muted" dot="none">
                {g}
              </Chip>
            ))}
          </div>
        ) : null}
        {result.overview ? <p className="mk-result__overview">{result.overview}</p> : null}
      </div>
      <div>
        {result.authorId != null ? (
          <Link className={buttonClass({ variant: 'ghost', size: 'sm' })} {...authorLink({ id: result.authorId })}>
            {t('common.open')}
          </Link>
        ) : (
          <Button size="sm" variant="secondary" aria-label={t('library.addNew.addTitle', { title: result.name })} onClick={onAdd}>
            {t('common.add')}
          </Button>
        )}
      </div>
    </article>
  );
}

export function AddAuthorDialog({ result, onClose }: { result: AuthorSearchResult | null; onClose: () => void }) {
  const { roots, profiles } = useAudiobookAddTarget(result !== null);
  return (
    <Modal open={result !== null} onClose={onClose} title={result ? t('library.addDialog.addTitle', { title: result.name }) : t('common.add')} size={560}>
      {result ? <AddAuthorForm key={result.asin ?? result.olAuthorId ?? result.name} result={result} onClose={onClose} roots={roots} profiles={profiles} /> : null}
    </Modal>
  );
}

function AddAuthorForm({ result, onClose, roots, profiles }: { result: AuthorSearchResult; onClose: () => void; roots: RootFolder[]; profiles: QualityProfile[] }) {
  const { target, setTarget, errors, valid, remember } = useTargetState(roots, profiles);
  const [monitorOption, setMonitorOption] = useState<AudiobookMonitorOption>('all');
  const [monitorNewBooks, setMonitorNewBooks] = useState<MonitorNewBooks>('all');
  const [tags, setTags] = useState<number[]>([]);
  const [searchOnAdd, setSearchOnAdd] = useState(false);
  const [touched, setTouched] = useState(false);
  const add = useAddAuthor();
  const toast = useToast();
  const navigate = useNavigate();
  const ids = useId();
  const fid = (k: string) => `${ids}-${k}`;

  const submit = () => {
    setTouched(true);
    if (!valid || target.qualityProfileId === null) return;
    remember();
    add.mutate(
      {
        ...(result.asin ? { asin: result.asin } : { olAuthorId: result.olAuthorId ?? undefined }),
        rootFolderPath: target.rootFolderPath,
        qualityProfileId: target.qualityProfileId,
        monitored: monitorOption !== 'none',
        monitorOption,
        monitorNewBooks,
        tags,
        searchOnAdd,
      },
      {
        onSuccess: (author) => {
          toast.push({ tone: 'ok', title: t('library.addDialog.addedTitle', { title: author.name }), message: t('audiobooks.add.booksLoadInTheBackground') });
          onClose();
          void navigate(authorLink(author));
        },
      },
    );
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
        <AuthorArt author={result} />
        <div style={{ minWidth: 0 }}>
          <div className="mk-result__title">{result.name}</div>
          <div className="mk-result__meta">{authorResultMeta(result)}</div>
        </div>
      </div>

      <TargetFields idPrefix={ids} target={target} onChange={setTarget} roots={roots} profiles={profiles} errors={errors} touched={touched} />

      <FormRow label={t('common.monitor')} htmlFor={fid('monitor')}>
        <Select id={fid('monitor')} value={monitorOption} onChange={(e) => setMonitorOption(e.target.value as AudiobookMonitorOption)}>
          {MONITOR_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {monitorOptionLabel(v)}
            </option>
          ))}
        </Select>
      </FormRow>

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

      <FormRow label={t('common.searchOnAdd')} htmlFor={fid('search')} captionInline caption={t('audiobooks.add.searchOnAddCaption')}>
        <Toggle id={fid('search')} checked={searchOnAdd} onChange={(e) => setSearchOnAdd(e.currentTarget.checked)} />
      </FormRow>

      <FormRow label={t('library.addDialog.destination')}>
        <div className="lib-path-preview" data-testid="path-preview">
          {authorFolder(target.rootFolderPath, result.name) || t('library.addDialog.chooseARootFolderTo')}
        </div>
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
        <Button type="submit" variant="primary" loading={add.isPending} disabled={target.qualityProfileId === null || (touched && !valid)}>
          {t('audiobooks.addAuthor')}
        </Button>
      </div>
    </form>
  );
}
