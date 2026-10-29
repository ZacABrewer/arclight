import { Link } from '@tanstack/react-router';
import type { Book } from '@arclight/shared';
import { StatusChip } from '../../../arclight/index.js';
import { MonitorSwitch } from '../../../components/media/media-kit.js';
import { BookCoverArt, bookLink } from './audiobook-kit.js';
import { bookYear, formatRuntime, positionLabel } from './audiobook-model.js';
import { t } from '../../../i18n/index.js';

/** One book on the author and series pages: cover, "Book 3", title, year, runtime, on-disk state. */
export function BookCard({ book, position, byline, onMonitor }: { book: Book; position?: string | null | undefined; byline?: string | undefined; onMonitor: (m: boolean) => void }) {
  const pos = positionLabel(position);
  return (
    <article className="music-album" aria-label={book.title} data-unmonitored={!book.monitored || undefined}>
      <span className="music-album__monitor">
        <MonitorSwitch monitored={book.monitored} onChange={onMonitor} label={t('common.monitorTitle', { monitored: book.monitored, title: book.title })} />
      </span>
      <Link {...bookLink(book)} className="music-card">
        <BookCoverArt book={book} progress={book.hasFile ? 100 : 0} progressTone={!book.monitored ? 'muted' : book.hasFile ? 'default' : 'warn'} />
        {pos ? <span className="ab-book__position">{pos}</span> : null}
        <span className="music-album__title">{book.title}</span>
      </Link>
      {byline ? <span className="ab-book__byline">{byline}</span> : null}
      <div className="music-album__meta">
        <span className="al-num">{bookYear(book) ?? '—'}</span>
        {book.runtimeMinutes ? <span>· {formatRuntime(book.runtimeMinutes)}</span> : null}
        <span style={{ marginLeft: 'auto' }}>
          <StatusChip status={book.hasFile ? 'downloaded' : book.monitored ? 'missing' : 'unmonitored'} />
        </span>
      </div>
    </article>
  );
}
