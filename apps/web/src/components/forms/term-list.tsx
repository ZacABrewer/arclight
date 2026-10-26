import { useState, type KeyboardEvent } from 'react';
import { Button } from '../button.js';
import { Input } from '../form.js';

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
export function TermList({ id, value, onChange, placeholder = 'Add a term, or /regex/' }: TermListProps) {
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
    <div className="term-list">
      {value.length > 0 ? (
        <ul className="chip-group">
          {value.map((t) => (
            <li key={t} className="chip chip-on">
              <code>{t}</code>
              <button type="button" className="chip-remove" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((v) => v !== t))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row">
        <Input id={id} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.currentTarget.value)} onKeyDown={onKeyDown} />
        <Button size="sm" onClick={commit} disabled={!draft.trim()}>
          Add
        </Button>
      </div>
    </div>
  );
}
