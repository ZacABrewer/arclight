import { useEffect, useId, useState } from 'react';
import type { RetentionCondition, RetentionRule, RetentionRuleInput } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Checkbox, ErrorBlock, Field, Input, Modal, Segmented, Select, Toggle } from '../../../arclight/index.js';
import { MultiSelect } from '../../../components/multi-select.js';
import { useRootFolders, useTags } from '../../../hooks/library.js';
import { useSaveRetentionRule } from '../../../hooks/retention.js';
import {
  ACTION_OPTIONS,
  CONDITION_OPTIONS,
  GIB,
  defaultCondition,
  emptyRule,
  normaliseRule,
  parseUserList,
  ruleToInput,
  validateRule,
  type ConditionType,
} from './retention-model.js';
import { t } from '../../../i18n/index.js';

export interface RuleEditorProps {
  open: boolean;
  /** null = new rule. */
  rule: RetentionRule | null;
  /** Names of the other rules (duplicate check). */
  otherNames: readonly string[];
  onClose: () => void;
}

/** One condition row: kind select + its value + Remove. */
function ConditionRow({ index, value, onChange, onRemove, canRemove }: { index: number; value: RetentionCondition; onChange: (c: RetentionCondition) => void; onRemove: () => void; canRemove: boolean }) {
  const kindId = useId();
  const valueId = useId();
  const [usersText, setUsersText] = useState(value.type === 'watchedByUsers' ? value.users.join(', ') : '');
  return (
    <div className="ret-cond" role="group" aria-label={t('library.retention.ruleEditor.conditionValue', { value: index + 1 })}>
      <label className="al-sr-only" htmlFor={kindId}>
        {t('library.retention.ruleEditor.conditionValueKind', { value: index + 1 })}
      </label>
      <Select
        id={kindId}
        value={value.type}
        options={CONDITION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        onChange={(e) => {
          const next = defaultCondition(e.currentTarget.value as ConditionType);
          setUsersText('');
          onChange(next);
        }}
      />
      {value.type === 'addedOlderThanDays' || value.type === 'notWatchedWithinDays' ? (
        <>
          <label className="al-sr-only" htmlFor={valueId}>
            {t('library.retention.ruleEditor.conditionValueDays', { value: index + 1 })}
          </label>
          <Input id={valueId} type="number" mono min={value.type === 'notWatchedWithinDays' ? 1 : 0} end="days" value={value.days} onChange={(e) => onChange({ ...value, days: Math.round(Number(e.currentTarget.value)) })} />
        </>
      ) : value.type === 'sizeAbove' ? (
        <>
          <label className="al-sr-only" htmlFor={valueId}>
            {t('library.retention.ruleEditor.conditionValueSize', { value: index + 1 })}
          </label>
          <Input
            id={valueId}
            type="number"
            mono
            min={0}
            step="any"
            end="GB"
            value={Math.round((value.bytes / GIB) * 100) / 100}
            onChange={(e) => onChange({ ...value, bytes: Math.max(0, Math.round(Number(e.currentTarget.value) * GIB)) })}
          />
        </>
      ) : value.type === 'watchedByUsers' ? (
        <>
          <label className="al-sr-only" htmlFor={valueId}>
            {t('library.retention.ruleEditor.conditionValueUsers', { value: index + 1 })}
          </label>
          <Input
            id={valueId}
            placeholder={t('library.retention.ruleEditor.aliceBob')}
            value={usersText}
            onChange={(e) => {
              setUsersText(e.currentTarget.value);
              onChange({ ...value, users: parseUserList(e.currentTarget.value) });
            }}
          />
        </>
      ) : (
        <span className="ret-cond__none al-caption">{t('library.retention.ruleEditor.noValueNeeded')}</span>
      )}
      <Button variant="ghost" size="sm" onClick={onRemove} disabled={!canRemove} aria-label={t('library.retention.ruleEditor.removeConditionValue', { value: index + 1 })}>
        {t('common.remove')}
      </Button>
    </div>
  );
}

/** Add / edit a retention rule (modal 640). */
export function RuleEditor({ open, rule, otherNames, onClose }: RuleEditorProps) {
  const [draft, setDraft] = useState<RetentionRuleInput>(() => (rule ? ruleToInput(rule) : emptyRule()));
  const [showErrors, setShowErrors] = useState(false);
  const save = useSaveRetentionRule();
  const tags = useTags();
  const roots = useRootFolders();
  const ids = { name: useId(), grace: useId(), keepReq: useId() };

  useEffect(() => {
    if (open) {
      setDraft(rule ? ruleToInput(rule) : emptyRule());
      setShowErrors(false);
      save.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule]);

  const set = <K extends keyof RetentionRuleInput>(k: K, v: RetentionRuleInput[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const errors = validateRule(draft, otherNames);
  const rootOptions = (roots.data ?? []).filter((r) => r.mediaType === draft.mediaType);

  const submit = () => {
    setShowErrors(true);
    if (errors.length) return;
    save.mutate({ id: rule?.id ?? null, body: normaliseRule(draft) }, { onSuccess: onClose });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size={640}
      title={rule ? t('library.retention.ruleEditor.editName', { name: rule.name }) : t('library.retention.ruleEditor.addRetentionRule')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {rule ? t('library.retention.ruleEditor.saveRule') : t('common.addRule')}
          </Button>
        </>
      }
    >
      <div className="ret-editor">
        <Field label={t('common.name')} htmlFor={ids.name}>
          <Input id={ids.name} value={draft.name} onChange={(e) => set('name', e.currentTarget.value)} />
        </Field>
        <div className="ret-editor__row">
          <Toggle label={t('common.enabled')} checked={draft.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
          <Segmented
            aria-label={t('common.mediaType')}
            value={draft.mediaType}
            onChange={(v) => setDraft((d) => ({ ...d, mediaType: v, scope: d.scope.type === 'rootFolders' ? { type: 'all' } : d.scope }))}
            options={[
              { value: 'movie', label: t('common.movies') },
              { value: 'series', label: t('common.series') },
            ]}
          />
        </div>

        <fieldset className="ret-fieldset">
          <legend className="al-label">{t('library.retention.ruleEditor.scope')}</legend>
          <Segmented
            aria-label={t('library.retention.ruleEditor.scope')}
            variant="soft"
            value={draft.scope.type}
            onChange={(v) =>
              set('scope', v === 'all' ? { type: 'all' } : v === 'tags' ? { type: 'tags', tagIds: [] } : { type: 'rootFolders', paths: [] })
            }
            options={[
              { value: 'all', label: t('library.retention.ruleEditor.wholeLibrary') },
              { value: 'tags', label: t('common.tags') },
              { value: 'rootFolders', label: t('common.rootFolders') },
            ]}
          />
          {draft.scope.type === 'tags' ? (
            <MultiSelect
              label={t('common.tags')}
              emptyLabel={t('common.none')}
              options={(tags.data ?? []).map((item) => ({ value: item.id, label: item.label }))}
              value={draft.scope.tagIds}
              onChange={(tagIds) => set('scope', { type: 'tags', tagIds })}
            />
          ) : null}
          {draft.scope.type === 'rootFolders' ? (
            <div className="ret-checklist">
              {rootOptions.length === 0 ? <p className="al-caption">{t('library.retention.ruleEditor.noRootFoldersForThis')}</p> : null}
              {rootOptions.map((r) => {
                const paths = draft.scope.type === 'rootFolders' ? draft.scope.paths : [];
                return (
                  <Checkbox
                    key={r.id}
                    label={<span className="al-num">{r.path}</span>}
                    checked={paths.includes(r.path)}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      set('scope', { type: 'rootFolders', paths: on ? [...paths, r.path] : paths.filter((p) => p !== r.path) });
                    }}
                  />
                );
              })}
            </div>
          ) : null}
        </fieldset>

        <fieldset className="ret-fieldset">
          <legend className="al-label">{t('library.retention.ruleEditor.conditionsAllMustHold')}</legend>
          {draft.conditions.map((c, i) => (
            <ConditionRow
              // eslint-disable-next-line react/no-array-index-key
              key={`${i}-${c.type}`}
              index={i}
              value={c}
              canRemove={draft.conditions.length > 1}
              onChange={(next) => set('conditions', draft.conditions.map((x, j) => (j === i ? next : x)))}
              onRemove={() => set('conditions', draft.conditions.filter((_, j) => j !== i))}
            />
          ))}
          <div>
            <Button variant="ghost" size="sm" onClick={() => set('conditions', [...draft.conditions, defaultCondition('addedOlderThanDays')])}>
              {t('library.retention.ruleEditor.addCondition')}
            </Button>
          </div>
        </fieldset>

        <fieldset className="ret-fieldset">
          <legend className="al-label">{t('common.action')}</legend>
          <Segmented aria-label={t('common.action')} value={draft.action} onChange={(v) => set('action', v)} options={ACTION_OPTIONS.map((a) => ({ value: a.value, label: a.label }))} />
          {draft.action === 'deleteItem' ? (
            <Checkbox label={t('library.retention.ruleEditor.addAnImportExclusionSo')} checked={draft.addExclusion} onChange={(e) => set('addExclusion', e.currentTarget.checked)} />
          ) : null}
          <Field label={t('library.retention.ruleEditor.gracePeriod')} htmlFor={ids.grace} hint={t('library.retention.ruleEditor.daysBetweenStagingAndApplying')}>
            <Input id={ids.grace} type="number" mono min={0} max={3650} end="days" value={draft.graceDays} onChange={(e) => set('graceDays', Math.round(Number(e.currentTarget.value)))} />
          </Field>
          <Toggle label={t('library.retention.ruleEditor.dryRunStageAndReport')} checked={draft.dryRun} onChange={(e) => set('dryRun', e.currentTarget.checked)} />
        </fieldset>

        <fieldset className="ret-fieldset">
          <legend className="al-label">{t('common.keep')}</legend>
          <Field label={t('library.retention.ruleEditor.keepIfRequestedWithin')} htmlFor={ids.keepReq} hint={t('library.retention.ruleEditor.emptyTurnsThisOff')}>
            <Input
              id={ids.keepReq}
              type="number"
              mono
              min={1}
              end="days"
              value={draft.keepIfRequestedWithinDays ?? ''}
              onChange={(e) => {
                const raw = e.currentTarget.value;
                set('keepIfRequestedWithinDays', raw === '' ? null : Math.max(1, Math.round(Number(raw))));
              }}
            />
          </Field>
          {draft.mediaType === 'movie' ? (
            <Checkbox label={t('library.retention.ruleEditor.keepMoviesThatBelongTo')} checked={draft.keepIfInCollection} onChange={(e) => set('keepIfInCollection', e.currentTarget.checked)} />
          ) : null}
        </fieldset>

        {showErrors && errors.length ? (
          <ul className="ret-errors" role="alert">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
        {save.isError ? <ErrorBlock title={t('library.retention.ruleEditor.couldNotSaveTheRule')}>{errorMessage(save.error)}</ErrorBlock> : null}
      </div>
    </Modal>
  );
}
