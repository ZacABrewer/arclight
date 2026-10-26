import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  /** Controlled selection. */
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
}

/** WAI-ARIA tabs with arrow-key navigation. Only the active panel is rendered. */
export function Tabs({ tabs, value, defaultValue, onChange }: TabsProps) {
  const baseId = useId();
  const [internal, setInternal] = useState(defaultValue ?? tabs[0]?.id ?? '');
  const active = value ?? internal;
  const enabled = tabs.filter((t) => !t.disabled);

  const select = (id: string) => {
    if (value === undefined) setInternal(id);
    onChange?.(id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const idx = enabled.findIndex((t) => t.id === active);
    let next: TabItem | undefined;
    if (e.key === 'ArrowRight') next = enabled[(idx + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(idx - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (next) {
      e.preventDefault();
      select(next.id);
      document.getElementById(`${baseId}-tab-${next.id}`)?.focus();
    }
  };

  const current = tabs.find((t) => t.id === active);

  return (
    <div className="tabs">
      <div role="tablist" className="tab-list" onKeyDown={onKeyDown}>
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`${baseId}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={t.id === active}
            aria-controls={`${baseId}-panel-${t.id}`}
            tabIndex={t.id === active ? 0 : -1}
            disabled={t.disabled}
            className={cx('tab', t.id === active && 'tab-active')}
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {current ? (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${current.id}`}
          aria-labelledby={`${baseId}-tab-${current.id}`}
          className="tab-panel"
        >
          {current.content}
        </div>
      ) : null}
    </div>
  );
}
