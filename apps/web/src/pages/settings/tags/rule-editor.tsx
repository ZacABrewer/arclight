import { useEffect, useId, useMemo, useState } from 'react';
import { TagRuleInput, TagRuleSetOp, type TagEntityType, type TagRule, type TagRuleCondition, type TagRuleField, type TagRuleOptions } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Checkbox, ErrorBlock, Field, Input, Modal, Segmented, Select, Tag, Toggle } from '../../../arclight/index.js';
import { MultiSelect } from '../../../components/multi-select.js';
import { useTags } from '../../../hooks/library.js';
import { useSaveTagRule, useTagRuleOptions } from '../../../hooks/tag-rules.js';
import { tagRulesApi } from '../../../api/tag-rules.js';
import { EditorFooter } from '../shared.js';
import { RunSummary } from './run-summary.js';
import {
  ENTITY_TYPES,
  defaultCondition,
  emptyRule,
  entityLabel,
  fieldLabel,
  fieldsFor,
  normaliseRule,
  opLabel,
  rangeUnit,
  ruleToInput,
  templateExample,
  templateVariablesFor,
} from './tags-model.js';
import type { TagRuleRunResult } from '@arclight/shared';
import { t } from '../../../i18n/index.js';

export interface TagRuleEditorProps {
  open: boolean;
  /** null = new rule. */
  rule: TagRule | null;
  onClose: () => void;
}

/** Free-text + suggestions picker for a set field's string values. */
function ValuesPicker({ label, values, suggestions, onChange }: { label: string; values: readonly string[]; suggestions: readonly string[]; onChange: (v: string[]) => void }) {
  const inputId = useId();
  const listId = useId();
  const [text, setText] = useState('');
  const add = () => {
    const v = text.trim();
    if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setText('');
  };
  return (
    <div className="tg-values">
      <div className="tg-values__entry">
        <label className="al-sr-only" htmlFor={inputId}>
          {label}
        </label>
        <Input
          id={inputId}
          list={listId}
          value={text}
          placeholder={t('settings.tags.editor.typeOrPick')}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <Button size="sm" variant="secondary" onClick={add} disabled={text.trim() === ''}>
          {t('common.add')}
        </Button>
      </div>
      {values.length ? (
        <span className="mk-tags">
          {values.map((v) => (
            <Tag key={v} onRemove={() => onChange(values.filter((x) => x !== v))} removeLabel={t('settings.tags.editor.removeValue', { value: v })}>
              {v}
            </Tag>
          ))}
        </span>
      ) : null}
    </div>
  );
}

function ConditionRow({
  index,
  value,
  fields,
  options,
  onChange,
  onRemove,
}: {
  index: number;
  value: TagRuleCondition;
  fields: readonly TagRuleField[];
  options: TagRuleOptions | undefined;
  onChange: (c: TagRuleCondition) => void;
  onRemove: () => void;
}) {
  const fieldId = useId();
  const opId = useId();
  const minId = useId();
  const maxId = useId();
  const tags = useTags();
  const n = index + 1;
  const fieldOptions = (fields.includes(value.field) ? fields : [value.field, ...fields]).map((f) => ({ value: f, label: fieldLabel(f) }));

  const idOptions =
    value.kind !== 'ids'
      ? []
      : value.field === 'tag'
        ? (tags.data ?? []).map((x) => ({ value: x.id, label: x.label }))
        : value.field === 'requestedBy'
          ? (options?.users ?? []).map((u) => ({ value: u.id, label: u.name }))
          : (options?.qualityProfiles ?? []).map((p) => ({ value: p.id, label: p.name }));

  return (
    <div className="tg-cond" role="group" aria-label={t('settings.tags.editor.conditionN', { n })}>
      <div className="tg-cond__head">
        <label className="al-sr-only" htmlFor={fieldId}>
          {t('settings.tags.editor.conditionNField', { n })}
        </label>
        <Select id={fieldId} value={value.field} options={fieldOptions} onChange={(e) => onChange(defaultCondition(e.currentTarget.value as TagRuleField))} />
        {value.kind === 'set' || value.kind === 'ids' ? (
          <>
            <label className="al-sr-only" htmlFor={opId}>
              {t('settings.tags.editor.conditionNOperator', { n })}
            </label>
            <Select
              id={opId}
              value={value.op}
              options={TagRuleSetOp.options.map((o) => ({ value: o, label: opLabel(o) }))}
              onChange={(e) => onChange({ ...value, op: e.currentTarget.value as TagRuleSetOp } as TagRuleCondition)}
            />
          </>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onRemove} aria-label={t('settings.tags.editor.removeConditionN', { n })}>
          {t('common.remove')}
        </Button>
      </div>
      {value.kind === 'set' && value.op !== 'present' && value.op !== 'absent' ? (
        <ValuesPicker
          label={t('settings.tags.editor.conditionNValues', { n })}
          values={value.values}
          suggestions={options?.values[value.field] ?? []}
          onChange={(values) => onChange({ ...value, values })}
        />
      ) : null}
      {value.kind === 'ids' && value.op !== 'present' && value.op !== 'absent' ? (
        <MultiSelect
          label={t('settings.tags.editor.conditionNValues', { n })}
          emptyLabel={t('common.none')}
          options={idOptions}
          value={value.ids}
          onChange={(ids) => onChange({ ...value, ids })}
        />
      ) : null}
      {value.kind === 'range' ? (
        <div className="tg-cond__range">
          <Field label={t('settings.tags.editor.min')} htmlFor={minId}>
            <Input
              id={minId}
              type="number"
              mono
              step="any"
              end={rangeUnit(value.field)}
              value={value.min ?? ''}
              onChange={(e) => onChange({ ...value, min: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })}
            />
          </Field>
          <Field label={t('settings.tags.editor.max')} htmlFor={maxId}>
            <Input
              id={maxId}
              type="number"
              mono
              step="any"
              end={rangeUnit(value.field)}
              value={value.max ?? ''}
              onChange={(e) => onChange({ ...value, max: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })}
            />
          </Field>
        </div>
      ) : null}
      {value.kind === 'bool' ? (
        <Segmented
          aria-label={t('settings.tags.editor.conditionNValues', { n })}
          variant="soft"
          value={value.value ? 'yes' : 'no'}
          onChange={(v) => onChange({ ...value, value: v === 'yes' })}
          options={[
            { value: 'yes', label: t('common.yes') },
            { value: 'no', label: t('common.no') },
          ]}
        />
      ) : null}
    </div>
  );
}

/** Live dry run of the draft (debounced); null while the draft is invalid. */
function usePreview(draft: TagRuleInput, id: number | undefined, open: boolean) {
  const [state, setState] = useState<{ result: TagRuleRunResult | null; loading: boolean; error: string | null }>({ result: null, loading: false, error: null });
  const body = useMemo(() => normaliseRule(draft), [draft]);
  const valid = TagRuleInput.safeParse(body).success;
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!open || !valid) {
      setState({ result: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      tagRulesApi
        .preview(body, id)
        .then((result) => !cancelled && setState({ result, loading: false, error: null }))
        .catch((err: unknown) => !cancelled && setState({ result: null, loading: false, error: errorMessage(err) }));
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, id, open, valid]);
  return { ...state, valid };
}

/** Add / edit a tag rule (modal 640). */
export function TagRuleEditor({ open, rule, onClose }: TagRuleEditorProps) {
  const [draft, setDraft] = useState<TagRuleInput>(() => (rule ? ruleToInput(rule) : emptyRule()));
  const [showErrors, setShowErrors] = useState(false);
  const save = useSaveTagRule();
  const options = useTagRuleOptions();
  const tags = useTags();
  const ids = { name: useId() };

  useEffect(() => {
    if (open) {
      setDraft(rule ? ruleToInput(rule) : emptyRule());
      setShowErrors(false);
      save.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule]);

  const preview = usePreview(draft, rule?.id, open);
  const set = <K extends keyof TagRuleInput>(k: K, v: TagRuleInput[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const fields = fieldsFor(draft.appliesTo);
  const variables = templateVariablesFor(draft.appliesTo);
  const parsed = TagRuleInput.safeParse(normaliseRule(draft));
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));

  const toggleType = (e: TagEntityType, on: boolean) => set('appliesTo', on ? ENTITY_TYPES.filter((x) => x === e || draft.appliesTo.includes(x)) : draft.appliesTo.filter((x) => x !== e));
  const insertVariable = (v: string) =>
    setDraft((d) => {
      const list = d.addTags.length ? [...d.addTags] : [''];
      const last = list.length - 1;
      list[last] = `${list[last] ?? ''}{${v}}`;
      return { ...d, addTags: list };
    });

  const submit = () => {
    setShowErrors(true);
    if (!parsed.success) return;
    save.mutate({ id: rule?.id ?? null, body: parsed.data }, { onSuccess: onClose });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size={640}
      title={rule ? t('settings.tags.editor.editName', { name: rule.name }) : t('settings.tags.editor.addTitle')}
      footer={<EditorFooter onCancel={onClose} onSave={submit} saving={save.isPending} />}
    >
      <div className="tg-editor">
        <Field label={t('common.name')} htmlFor={ids.name}>
          <Input id={ids.name} value={draft.name} onChange={(e) => set('name', e.currentTarget.value)} />
        </Field>
        <Toggle label={t('common.enabled')} checked={draft.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />

        <fieldset className="tg-fieldset">
          <legend className="al-label">{t('settings.tags.editor.appliesTo')}</legend>
          <div className="tg-checks">
            {ENTITY_TYPES.map((e) => (
              <Checkbox key={e} label={entityLabel(e)} checked={draft.appliesTo.includes(e)} onChange={(ev) => toggleType(e, ev.currentTarget.checked)} />
            ))}
          </div>
        </fieldset>

        <fieldset className="tg-fieldset">
          <legend className="al-label">{t('common.conditions')}</legend>
          <Segmented
            aria-label={t('settings.tags.editor.match')}
            variant="soft"
            value={draft.match}
            onChange={(v) => set('match', v)}
            options={[
              { value: 'all', label: t('settings.tags.editor.matchAll') },
              { value: 'any', label: t('settings.tags.editor.matchAny') },
            ]}
          />
          {draft.conditions.length === 0 ? <p className="al-caption">{t('settings.tags.editor.noConditions')}</p> : null}
          {draft.conditions.map((c, i) => (
            <ConditionRow
              // eslint-disable-next-line react/no-array-index-key
              key={`${i}-${c.field}`}
              index={i}
              value={c}
              fields={fields}
              options={options.data}
              onChange={(next) => set('conditions', draft.conditions.map((x, j) => (j === i ? next : x)))}
              onRemove={() => set('conditions', draft.conditions.filter((_, j) => j !== i))}
            />
          ))}
          <div>
            <Button variant="ghost" size="sm" disabled={fields.length === 0} onClick={() => set('conditions', [...draft.conditions, defaultCondition(fields[0] ?? 'genre')])}>
              {t('settings.tags.editor.addCondition')}
            </Button>
          </div>
        </fieldset>

        <fieldset className="tg-fieldset">
          <legend className="al-label">{t('settings.tags.editor.addTags')}</legend>
          <p className="al-caption">{t('settings.tags.editor.addTagsHint')}</p>
          {draft.addTags.map((label, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className="tg-addtag">
              <div className="tg-addtag__row">
                <Input
                  mono
                  aria-label={t('settings.tags.editor.tagN', { n: i + 1 })}
                  value={label}
                  placeholder="genre:{genre}"
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    set('addTags', draft.addTags.map((x, j) => (j === i ? v : x)));
                  }}
                />
                <Button variant="ghost" size="sm" onClick={() => set('addTags', draft.addTags.filter((_, j) => j !== i))} aria-label={t('settings.tags.editor.removeTagN', { n: i + 1 })}>
                  {t('common.remove')}
                </Button>
              </div>
              {label.trim() ? (
                <span className="al-caption" data-testid="tag-example">
                  {t('settings.tags.editor.example', { label: templateExample(label) || '—' })}
                </span>
              ) : null}
            </div>
          ))}
          <div>
            <Button variant="ghost" size="sm" onClick={() => set('addTags', [...draft.addTags, ''])}>
              {t('settings.tags.editor.addTag')}
            </Button>
          </div>
          <div className="tg-vars" role="group" aria-label={t('settings.tags.editor.templateHelper')}>
            <span className="al-label">{t('settings.tags.editor.insertVariable')}</span>
            {variables.map((v) => (
              <button key={v} type="button" className="al-tag al-tag-toggle" onClick={() => insertVariable(v)}>
                {`{${v}}`}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="tg-fieldset">
          <legend className="al-label">{t('settings.tags.editor.removeTags')}</legend>
          <MultiSelect
            label={t('settings.tags.editor.removeTags')}
            emptyLabel={t('common.none')}
            options={(tags.data ?? []).map((x) => ({ value: x.id, label: x.label }))}
            value={draft.removeTagIds}
            onChange={(v) => set('removeTagIds', v)}
          />
          <Toggle label={t('settings.tags.editor.removeWhenUnmatched')} checked={draft.removeWhenUnmatched} onChange={(e) => set('removeWhenUnmatched', e.currentTarget.checked)} />
          <p className="al-caption">{t('settings.tags.editor.removeWhenUnmatchedHint')}</p>
        </fieldset>

        <section className="tg-preview" aria-label={t('settings.tags.editor.preview')} aria-live="polite">
          <div className="al-label">{t('settings.tags.editor.preview')}</div>
          {!preview.valid ? (
            <p className="al-caption">{t('settings.tags.editor.previewInvalid')}</p>
          ) : preview.error ? (
            <p className="al-caption">{preview.error}</p>
          ) : preview.result ? (
            <RunSummary result={preview.result} compact />
          ) : (
            <p className="al-caption">{t('settings.tags.editor.previewLoading')}</p>
          )}
        </section>

        {showErrors && issues.length ? (
          <ul className="tg-errors" role="alert">
            {issues.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
        {save.isError ? <ErrorBlock title={t('settings.tags.couldNotSaveRule')}>{errorMessage(save.error)}</ErrorBlock> : null}
      </div>
    </Modal>
  );
}
