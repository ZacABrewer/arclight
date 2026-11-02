import { useId, useMemo, useRef, useState } from 'react';
import type { NotificationMessageTemplate, NotificationTemplates } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Banner, Button, ErrorBlock, Field, Input, Select, Skeleton, Textarea } from '../../arclight/index.js';
import { useDebouncedValue } from '../../hooks/metadata.js';
import { useNotificationPreview, useNotificationTemplateMeta } from '../../hooks/notifications.js';
import { t } from '../../i18n/index.js';
import { eventTypeLabel } from './labels.js';
import './notifications.css';

// Per-event message templates with a live preview rendered by the api against a sample event.
// `default` applies to every event without its own template.

/** `templates` with `key` set to `template`; an entry with neither part is removed. */
export function setTemplate(templates: NotificationTemplates, key: string, template: NotificationMessageTemplate): NotificationTemplates {
  const next = { ...templates };
  const clean: NotificationMessageTemplate = {};
  if (template.title) clean.title = template.title;
  if (template.body) clean.body = template.body;
  if (clean.title === undefined && clean.body === undefined) delete next[key];
  else next[key] = clean;
  return next;
}

/** `text` with `insert` placed over the selection `start`..`end`. */
export function insertAt(text: string, insert: string, start: number | null, end: number | null): { text: string; caret: number } {
  const from = start ?? text.length;
  const to = end ?? from;
  return { text: text.slice(0, from) + insert + text.slice(to), caret: from + insert.length };
}

export interface TemplateEditorProps {
  value: NotificationTemplates;
  onChange: (next: NotificationTemplates) => void;
  /** Limit the event list (personal destinations); defaults to every key the api offers. */
  keys?: readonly string[] | undefined;
}

export function TemplateEditor({ value, onChange, keys }: TemplateEditorProps) {
  const meta = useNotificationTemplateMeta();
  const id = useId();
  const [key, setKey] = useState('default');
  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [target, setTarget] = useState<'title' | 'body'>('body');

  const available = useMemo(() => {
    const all = meta.data?.keys ?? [];
    const list = keys ? all.filter((k) => k === 'default' || keys.includes(k)) : all;
    return list.includes('default') ? list : ['default', ...list];
  }, [meta.data, keys]);

  const current = value[key] ?? {};
  const title = current.title ?? '';
  const body = current.body ?? '';
  const update = (patch: NotificationMessageTemplate) => onChange(setTemplate(value, key, { title, body, ...patch }));

  const request = useMemo(() => ({ eventType: key, template: { ...(title ? { title } : {}), ...(body ? { body } : {}) } }), [key, title, body]);
  const debounced = useDebouncedValue(request, 400);
  const preview = useNotificationPreview(meta.data ? debounced : null);

  const insert = (name: string) => {
    const token = `{{${name}}}`;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const into = active && active === titleRef.current ? 'title' : active && active === bodyRef.current ? 'body' : target;
    const el = into === 'title' ? titleRef.current : bodyRef.current;
    const source = into === 'title' ? title : body;
    const { text, caret } = insertAt(source, token, el?.selectionStart ?? null, el?.selectionEnd ?? null);
    update(into === 'title' ? { title: text } : { body: text });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  if (meta.isPending) return <Skeleton lines={4} />;
  if (meta.isError) {
    return (
      <ErrorBlock title={t('notify.templates.couldNotLoad')} onRetry={() => void meta.refetch()}>
        {errorMessage(meta.error)}
      </ErrorBlock>
    );
  }

  const customized = new Set(Object.keys(value));
  return (
    <div className="al-template-editor">
      <p className="al-caption al-template-editor__intro">{t('notify.templates.intro')}</p>
      <div className="al-template-editor__bar">
        <Field label={t('notify.templates.event')} htmlFor={`${id}-key`}>
          <Select
            id={`${id}-key`}
            className="al-select--fit"
            value={key}
            onChange={(e) => setKey(e.currentTarget.value)}
            options={available.map((k) => ({
              value: k,
              label: customized.has(k) ? t('notify.templates.customized', { label: eventTypeLabel(k) }) : eventTypeLabel(k),
            }))}
          />
        </Field>
        {customized.has(key) ? (
          <Button size="sm" variant="ghost" onClick={() => onChange(setTemplate(value, key, {}))}>
            {t('notify.templates.reset')}
          </Button>
        ) : null}
      </div>
      <Field label={t('notify.templates.title')} hint={t('notify.templates.titleHint')} htmlFor={`${id}-title`}>
        <Input
          id={`${id}-title`}
          ref={titleRef}
          mono
          value={title}
          maxLength={500}
          onFocus={() => setTarget('title')}
          onChange={(e) => update({ title: e.currentTarget.value })}
        />
      </Field>
      <Field label={t('notify.templates.body')} hint={t('notify.templates.bodyHint')} htmlFor={`${id}-body`}>
        <Textarea
          id={`${id}-body`}
          ref={bodyRef}
          mono
          rows={5}
          value={body}
          maxLength={4000}
          onFocus={() => setTarget('body')}
          onChange={(e) => update({ body: e.currentTarget.value })}
        />
      </Field>
      <div className="al-template-vars">
        <span className="al-template-vars__label">{t('notify.templates.variables', { field: target === 'title' ? t('notify.templates.title') : t('notify.templates.body') })}</span>
        <ul className="al-template-vars__list" aria-label={t('notify.templates.variableList')}>
          {(meta.data.variables ?? []).map((v) => (
            <li key={v.name}>
              <button type="button" className="al-template-vars__item" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(v.name)} title={v.description}>
                <code>{`{{${v.name}}}`}</code>
                <span>{v.description}</span>
                {preview.data?.values[v.name] ? <span className="al-template-vars__sample">{preview.data.values[v.name]}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <section className="al-template-preview" aria-label={t('notify.templates.preview')} aria-busy={preview.isFetching || undefined}>
        <span className="al-label">{t('notify.templates.preview')}</span>
        {preview.isError ? (
          <Banner tone="danger">{errorMessage(preview.error)}</Banner>
        ) : preview.data ? (
          <>
            {preview.data.error ? <Banner tone="warn">{t('notify.templates.previewError', { error: preview.data.error })}</Banner> : null}
            <div className="al-template-preview__card">
              <strong className="al-template-preview__title">{preview.data.title}</strong>
              <p className="al-template-preview__body">{preview.data.body}</p>
              {preview.data.link ? <span className="al-template-preview__link">{preview.data.link}</span> : null}
            </div>
          </>
        ) : (
          <Skeleton lines={2} />
        )}
      </section>
    </div>
  );
}
