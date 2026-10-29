import type { GrabOverride } from '@arclight/shared';
import { Button, Chip, RejectionList, Tooltip } from '../../arclight/index.js';
import { t } from '../../i18n/index.js';

/**
 * "Kept by choice": the file came from a "Grab anyway" grab, so automatic searches leave it
 * alone. The tooltip lists the rules the user overrode; the button allows upgrades again.
 */
export function KeptByChoice({ override, onAllow, allowing }: { override: GrabOverride; onAllow: () => void; allowing: boolean }) {
  const reasons = override.rejections;
  return (
    <span className="al-kept">
      <Tooltip
        content={
          <span className="al-kept__tip">
            <span>{t('library.keptByChoice.explanation')}</span>
            <RejectionList reasons={reasons} />
          </span>
        }
      >
        <button type="button" className="mk-action-link" aria-label={t('library.keptByChoice.ariaLabel', { reasons: reasons.join('; ') })}>
          <Chip tone="warn" dot="ring" data-testid="kept-by-choice">
            {t('library.keptByChoice.marker')}
          </Chip>
        </button>
      </Tooltip>
      <Button size="sm" variant="ghost" loading={allowing} onClick={onAllow}>
        {t('library.keptByChoice.allowUpgrades')}
      </Button>
    </span>
  );
}
