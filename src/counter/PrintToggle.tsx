import { useState } from 'react';
import { Icon } from '../components/Icon';
import { useI18n } from '../lib/I18nProvider';
import { paperWidth, printsReceipts, setPaperWidth, setPrintsReceipts } from './Receipt';
import type { PaperWidth } from './Receipt';

/** In the name menu: whether this phone prints a receipt after each sale (a phone with no printer can turn it off). */
export function PrintToggle() {
  const { t } = useI18n();
  const [on, setOn] = useState(printsReceipts);
  return (
    <button
      type="button"
      className="c-btn c-btn-secondary"
      aria-pressed={on}
      onClick={() => {
        setPrintsReceipts(!on);
        setOn(!on);
      }}
    >
      <Icon name="receipt" size={20} strokeWidth={2.4} />
      {on ? t('receipt.autoOn') : t('receipt.autoOff')}
    </button>
  );
}

/** In the name menu: the width of this phone's receipt roll. */
export function PaperToggle() {
  const { t } = useI18n();
  const [width, setWidth] = useState<PaperWidth>(paperWidth);
  return (
    <div className="c-paper-choice" role="group" aria-label={t('receipt.paper')}>
      <span>{t('receipt.paper')}</span>
      {([80, 58] as const).map((w) => (
        <button
          key={w}
          type="button"
          className="c-tab"
          aria-pressed={width === w}
          onClick={() => {
            setPaperWidth(w);
            setWidth(w);
          }}
        >
          {w} mm
        </button>
      ))}
    </div>
  );
}
