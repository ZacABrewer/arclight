import { useId, type ReactNode } from 'react';
import { cx } from '../cx.js';
import { Button } from './Button.js';
import { Input } from './Input.js';
import { t } from '../../i18n/index.js';

export interface PathEntry {
  name: string;
  path: string;
  kind?: 'folder' | 'file' | 'drive' | undefined;
  /** Right-aligned meta ("6.4 TB free", "1.2 GB"). */
  meta?: ReactNode | undefined;
}

export interface PathCrumb {
  label: string;
  path: string;
}

export interface PathPickerFieldProps {
  /** Text in the path input. */
  value: string;
  onChange: (value: string) => void;
  /** Entries of the folder being browsed (data via props — the page owns fetching). */
  entries: readonly PathEntry[];
  /** Breadcrumb of the browsed folder ("/ › media"). */
  crumbs?: readonly PathCrumb[] | undefined;
  /** Open a folder (double-click / → on a folder row, or click a crumb). A single click selects it into `value`. */
  onNavigate: (path: string) => void;
  /** Highlighted entry (usually equals `value`). */
  selectedPath?: string | undefined;
  /** Clicking a file selects it (otherwise files are inert). */
  onSelectFile?: ((path: string) => void) | undefined;
  /** "Add" button next to the input (wizard root folders). Omit to hide. */
  onAdd?: ((path: string) => void) | undefined;
  addLabel?: string | undefined;
  loading?: boolean | undefined;
  error?: ReactNode | undefined;
  label?: string | undefined;
  placeholder?: string | undefined;
  /** Hide the browser list (input only). */
  collapsed?: boolean | undefined;
  className?: string | undefined;
}

/** Path input + directory browser list (Page 08). Mono paths, 38px rows, square glyphs. */
export function PathPickerField({
  value,
  onChange,
  entries,
  crumbs,
  onNavigate,
  selectedPath,
  onSelectFile,
  onAdd,
  addLabel = t('common.add'),
  loading,
  error,
  label = t('common.path'),
  placeholder = '/media',
  collapsed,
  className,
}: PathPickerFieldProps) {
  const id = useId();
  const listId = `${id}-list`;
  const selected = selectedPath ?? value;
  return (
    <div className={cx('al-pathpicker', className)}>
      <label htmlFor={id} className="al-sr-only">
        {label}
      </label>
      <div className="al-pathpicker__row">
        <Input
          id={id}
          mono
          size="lg"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          invalid={!!error}
          aria-controls={collapsed ? undefined : listId}
          onChange={(e) => onChange(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (onAdd) onAdd(value);
            else onNavigate(value);
          }}
        />
        {onAdd ? (
          <Button size="lg" onClick={() => onAdd(value)} disabled={!value.trim()}>
            {addLabel}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="al-field__error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
      {collapsed ? null : (
        <div className="al-browser">
          {crumbs && crumbs.length > 0 ? (
            <nav className="al-browser__crumbs" aria-label={t('arclight.pathPickerField.currentFolder')}>
              {crumbs.map((c, i) => (
                <span key={c.path} style={{ display: 'contents' }}>
                  {i > 0 ? <span aria-hidden="true">›</span> : null}
                  <button
                    type="button"
                    className="al-browser__crumb"
                    aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                    onClick={() => onNavigate(c.path)}
                  >
                    {c.label}
                  </button>
                </span>
              ))}
            </nav>
          ) : null}
          {loading ? (
            <div className="al-browser__status" aria-busy="true">
              {t('arclight.pathPickerField.loadingFolders')}
            </div>
          ) : entries.length === 0 ? (
            <div className="al-browser__status">{t('arclight.pathPickerField.thisFolderIsEmpty')}</div>
          ) : (
            <ul id={listId} className="al-browser__list" role="listbox" aria-label={t('arclight.pathPickerField.folders')}>
              {entries.map((e) => {
                const kind = e.kind ?? 'folder';
                const inert = kind === 'file' && !onSelectFile;
                return (
                  <li key={e.path} role="presentation">
                    <button
                      type="button"
                      role="option"
                      className="al-browser__entry"
                      data-kind={kind}
                      aria-selected={e.path === selected}
                      disabled={inert}
                      title={kind === 'file' ? undefined : t('arclight.pathPickerField.doubleClickOrToOpen')}
                      onClick={() => {
                        if (kind === 'file') onSelectFile?.(e.path);
                        else onChange(e.path);
                      }}
                      onDoubleClick={() => {
                        if (kind !== 'file') onNavigate(e.path);
                      }}
                      onKeyDown={(ev) => {
                        if (ev.key === 'ArrowRight' && kind !== 'file') {
                          ev.preventDefault();
                          onNavigate(e.path);
                        }
                      }}
                    >
                      <span className="al-browser__glyph" aria-hidden="true" />
                      {e.name}
                      {e.meta ? <span className="al-browser__meta">{e.meta}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
