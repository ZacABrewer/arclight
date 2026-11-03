import { Children, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../../arclight/cx.js';
import { useT } from '../../../i18n/index.js';
import { RdIcon } from './icons.js';

// A home row (redesign spec §4.2, §4.4, §4.6): the title (19/700, 18 on phones) over a
// horizontal scroller. Phones scroll-snap with 16 px gutters; with a mouse, arrow buttons sit
// at both ends (the scrollbar is hidden) and show while hovering the row.

export interface RowProps {
  title: string;
  children: ReactNode;
  className?: string | undefined;
  /** Extra element after the title (e.g. a "See all" link). */
  action?: ReactNode;
}

export function Row({ title, children, className, action }: RowProps) {
  const t = useT();
  const id = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft >= max - 2 });
  }, []);

  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, children]);

  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    const reduce = el.closest('.rd-root')?.classList.contains('rd-reduce-motion');
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: reduce ? 'auto' : 'smooth' });
  };

  if (Children.count(children) === 0) return null;
  return (
    <section className={cx('rd-row', className)} aria-labelledby={id}>
      <div className="rd-row__head">
        <h2 className="rd-row__title" id={id}>
          {title}
        </h2>
        {action}
      </div>
      <div className="rd-row__frame">
        <div ref={scroller} className="rd-row__scroller" onScroll={measure}>
          <ul className="rd-row__items">
            {Children.map(children, (child) => (child ? <li className="rd-row__item">{child}</li> : null))}
          </ul>
        </div>
        {!edges.start ? (
          <button type="button" className="rd-row__arrow rd-row__arrow--prev" tabIndex={-1} aria-label={t('player.redesign.row.previous')} onClick={() => page(-1)}>
            <RdIcon name="chevronLeft" size={28} />
          </button>
        ) : null}
        {!edges.end ? (
          <button type="button" className="rd-row__arrow rd-row__arrow--next" tabIndex={-1} aria-label={t('player.redesign.row.next')} onClick={() => page(1)}>
            <RdIcon name="chevronRight" size={28} />
          </button>
        ) : null}
      </div>
    </section>
  );
}
