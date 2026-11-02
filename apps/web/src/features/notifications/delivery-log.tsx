import type { UseQueryResult } from '@tanstack/react-query';
import type { NotificationDelivery, NotificationDeliveryStatus } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Button, Chip, ErrorBlock, Table, Tag, type Column } from '../../arclight/index.js';
import { formatDateTime, t } from '../../i18n/index.js';
import { deliveryStateLabel, deliveryStateTone, deliveryStatusSummary, eventTypeLabel } from './labels.js';
import './notifications.css';

/** "N consecutive failures · last error: ..." as a warning line; nothing while deliveries succeed. */
export function DeliveryStatusLine({ status }: { status: NotificationDeliveryStatus | undefined | null }) {
  const summary = deliveryStatusSummary(status);
  if (!summary) return null;
  return (
    <span className="al-delivery-status" role="status">
      {summary}
    </span>
  );
}

function columns(): Array<Column<NotificationDelivery>> {
  return [
    { key: 'at', header: t('notify.log.when'), cell: (d) => formatDateTime(d.at), mono: true, width: '150px' },
    {
      key: 'eventType',
      header: t('notify.log.event'),
      cell: (d) => (
        <span className="al-delivery-event">
          {eventTypeLabel(d.eventType)}
          {d.test ? <Tag>{t('notify.log.test')}</Tag> : null}
        </span>
      ),
    },
    { key: 'title', header: t('notify.log.message'), cell: (d) => d.title, mobile: 'primary' },
    { key: 'state', header: t('notify.log.state'), cell: (d) => <Chip tone={deliveryStateTone(d.state)}>{deliveryStateLabel(d.state)}</Chip> },
    { key: 'attempts', header: t('notify.log.attempts'), cell: (d) => d.attempts, mono: true, align: 'right', width: '90px' },
    {
      key: 'error',
      header: t('notify.log.error'),
      cell: (d) => (d.error ? <span className="al-delivery-error">{d.code ? `${d.code}: ${d.error}` : d.error}</span> : '—'),
      muted: true,
    },
  ];
}

/** Recent delivery attempts of one destination, newest first. */
export function DeliveryLog({ query, status }: { query: UseQueryResult<NotificationDelivery[]>; status?: NotificationDeliveryStatus | undefined }) {
  if (query.isError) {
    return (
      <ErrorBlock title={t('notify.log.couldNotLoad')} onRetry={() => void query.refetch()}>
        {errorMessage(query.error)}
      </ErrorBlock>
    );
  }
  return (
    <div className="al-delivery-log">
      <div className="al-delivery-log__head">
        <DeliveryStatusLine status={status} />
        <Button size="sm" variant="ghost" onClick={() => void query.refetch()} loading={query.isFetching && !query.isPending}>
          {t('notify.log.refresh')}
        </Button>
      </div>
      <Table
        caption={t('notify.log.caption')}
        columns={columns()}
        rows={query.data}
        loading={query.isPending}
        rowKey={(d) => d.id}
        empty={t('notify.log.empty')}
        maxHeight={360}
      />
    </div>
  );
}
