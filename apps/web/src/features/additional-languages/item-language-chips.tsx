import { useState } from 'react';
import type { AdditionalLanguageKind, AdditionalLanguageRecord, ItemLanguageChip, ItemLanguagesQuery } from '@arclight/shared';
import { Button, Chip, Icon, Modal, Tooltip } from '../../arclight/index.js';
import { useItemLanguages, useRemoveAdditionalLanguage } from '../../hooks/additional-languages.js';
import { t } from '../../i18n/index.js';
import { useLanguageName } from '../../pages/subtitles/subtitle-ui.js';
import { subtitleKeyLabel } from './model.js';
import './additional-languages.css';

// The item's audio and subtitle languages as chips. Languages added with "Add additional…" are
// marked; one that is not on disk yet reads "wanted". A saved one can be removed (× + confirm).

/** Saved records behind a chip: same kind, same base language (`en:forced` → `en`). */
export function recordsForChip(records: readonly AdditionalLanguageRecord[], kind: AdditionalLanguageKind, chip: ItemLanguageChip): AdditionalLanguageRecord[] {
  const [code = chip.language, flag] = chip.language.split(':');
  return records.filter((r) => {
    if (r.kind !== kind || r.language !== code) return false;
    if (kind === 'audio') return true;
    if (flag === 'forced') return r.forced !== 'never';
    if (flag === 'hi') return r.hi !== 'never';
    return r.forced !== 'only';
  });
}

export function ItemLanguageChips({ query }: { query: ItemLanguagesQuery }) {
  const languages = useItemLanguages(query);
  const remove = useRemoveAdditionalLanguage();
  const name = useLanguageName();
  const [pending, setPending] = useState<{ label: string; ids: number[] } | null>(null);
  if (!languages.data) return null;
  const { audio, subtitles, records } = languages.data;
  if (audio.length === 0 && subtitles.length === 0) return null;

  const row = (kind: AdditionalLanguageKind, label: string, chips: readonly ItemLanguageChip[]) => (
    <div className="addl-chips__row" role="group" aria-label={label}>
      <span className="addl-chips__label">{label}</span>
      {chips.length === 0 ? <span className="mk-muted">{kind === 'audio' ? t('features.additionalLanguages.chips.notAnalysed') : t('features.additionalLanguages.chips.none')}</span> : null}
      {chips.map((c) => {
        const text = kind === 'audio' ? name(c.language) : subtitleKeyLabel(c.language, name);
        const saved = c.added ? recordsForChip(records, kind, c) : [];
        const chip = c.added ? (
          <Tooltip content={c.present ? t('features.additionalLanguages.chips.addedPresent') : t('features.additionalLanguages.chips.addedWanted')}>
            <span tabIndex={0}>
              <Chip tone={c.present ? 'accent' : 'warn'} dot={c.present ? 'fill' : 'ring'} data-added="true">
                {c.present ? t('features.additionalLanguages.chips.added', { name: text }) : t('features.additionalLanguages.chips.wanted', { name: text })}
              </Chip>
            </span>
          </Tooltip>
        ) : (
          <Chip tone="neutral">{text}</Chip>
        );
        return (
          <span key={c.language} className="addl-chips__item">
            {chip}
            {saved.length > 0 ? (
              <button
                type="button"
                className="addl-chips__remove"
                aria-label={t('features.additionalLanguages.chips.removeLabel', { name: text })}
                onClick={() => setPending({ label: text, ids: saved.map((r) => r.id) })}
              >
                <Icon name="close" size={16} />
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );

  return (
    <div className="addl-chips" data-testid="item-languages">
      {row('audio', t('features.additionalLanguages.chips.audio'), audio)}
      {row('subtitle', t('features.additionalLanguages.chips.subtitles'), subtitles)}
      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        size={440}
        title={t('features.additionalLanguages.chips.removeTitle', { name: pending?.label ?? '' })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={async () => {
                const ids = pending?.ids ?? [];
                for (const id of ids) await remove.mutateAsync(id).catch(() => undefined);
                setPending(null);
              }}
            >
              {t('common.remove')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{t('features.additionalLanguages.chips.removeBody')}</p>
      </Modal>
    </div>
  );
}
