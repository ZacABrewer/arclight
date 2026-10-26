import { useState, type KeyboardEvent } from 'react';
import { Button, Input, Tag } from '../../arclight/index.js';
import { t } from '../../i18n/index.js';

/** Split pasted text into terms (comma or newline separated), trimmed and de-duplicated. */
export function addTerms(existing: readonly string[], text: string): string[] {
  const out = [...existing];
  for (const raw of text.split(/[\n,]/)) {
    const term = raw.trim();
    if (term && !out.includes(term)) out.push(term);
  }
  return out;
}

export interface TermListProps {
  id?: string;
  value: readonly string[];
  onChange: (terms: string[]) => void;
  placeholder?: string;
}

/** Editable list of terms (release profile required/ignored words, file extensions...). */
export function TermList({ id, value, onChange, placeholder = t('components.forms.termList.addATermOrRegex') }: TermListProps) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    if (!draft.trim()) return;
    onChange(addTerms(value, draft));
    setDraft('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div className="al-term-list">
      {value.length > 0 ? (
        <ul className="al-term-list__terms">
          {value.map((item) => (
            <li key={item}>
              <Tag className="al-num" onRemove={() => onChange(value.filter((v) => v !== item))} removeLabel={t('components.forms.termList.removeT', { t: item })}>
                {item}
              </Tag>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="al-term-list__add">
        <Input id={id} mono value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.currentTarget.value)} onKeyDown={onKeyDown} />
        <Button variant="secondary" size="sm" onClick={commit} disabled={!draft.trim()}>
          {t('common.add')}
        </Button>
      </div>
    </div>
  );
}
