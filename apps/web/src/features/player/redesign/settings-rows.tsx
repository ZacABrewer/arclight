import { useState, type ReactNode } from 'react';
import { cx } from '../../../arclight/cx.js';
import { BottomSheet } from './sheet.js';
import { RdIcon } from './icons.js';

// Settings option rows (redesign spec §4.2, the template's Settings screen): a 52x30 toggle, a
// choice row that cycles its values in the accent with "›" (in `sheet` mode, used on phones,
// it opens a bottom-sheet picker instead), an info row and an action row.

interface RowText {
  label: string;
  desc?: string | null | undefined;
}

function RowLabel({ label, desc }: RowText) {
  return (
    <span className="rd-opt__text">
      <span className="rd-opt__label">{label}</span>
      {desc ? <span className="rd-opt__desc">{desc}</span> : null}
    </span>
  );
}

export function ToggleRow({ label, desc, checked, onChange, disabled }: RowText & { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean | undefined }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="rd-opt" disabled={disabled} onClick={() => onChange(!checked)}>
      <RowLabel label={label} desc={desc} />
      <span className={cx('rd-toggle', checked && 'is-on')} aria-hidden="true">
        <span className="rd-toggle__knob" />
      </span>
    </button>
  );
}

export interface ChoiceOption<V extends string> {
  value: V;
  label: string;
}

export function ChoiceRow<V extends string>({
  label,
  desc,
  value,
  options,
  onChange,
  mode = 'cycle',
}: RowText & { value: V; options: readonly ChoiceOption<V>[]; onChange: (next: V) => void; mode?: 'cycle' | 'sheet' | undefined }) {
  const [open, setOpen] = useState(false);
  const i = Math.max(0, options.findIndex((o) => o.value === value));
  const current = options[i]?.label ?? '';
  const onClick = () => {
    if (mode === 'sheet') setOpen(true);
    else if (options.length) onChange(options[(i + 1) % options.length]!.value);
  };
  return (
    <>
      <button type="button" className="rd-opt" onClick={onClick} aria-haspopup={mode === 'sheet' ? 'dialog' : undefined}>
        <RowLabel label={label} desc={desc} />
        <span className="rd-opt__choice">
          {current}
          <span className="rd-opt__more" aria-hidden="true">
            ›
          </span>
        </span>
      </button>
      {mode === 'sheet' ? (
        <BottomSheet open={open} onClose={() => setOpen(false)} title={label}>
          <div className="rd-sheet__list" role="listbox" aria-label={label}>
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={cx('rd-sheet__item', o.value === value && 'is-on')}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span>{o.label}</span>
                {o.value === value ? <RdIcon name="check" size={20} className="rd-accent" /> : null}
              </button>
            ))}
          </div>
        </BottomSheet>
      ) : null}
    </>
  );
}

export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rd-opt rd-opt--info">
      <RowLabel label={label} />
      <span className="rd-opt__info">{value}</span>
    </div>
  );
}

export function ActionRow({ label, desc, value, onClick }: RowText & { value?: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="rd-opt" onClick={onClick}>
      <RowLabel label={label} desc={desc} />
      <span className="rd-opt__action">
        {value}
        <span className="rd-opt__more" aria-hidden="true">
          ›
        </span>
      </span>
    </button>
  );
}
