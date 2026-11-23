import { useState } from 'react';
import { Icon } from '../components/Icon';
import { useI18n } from '../lib/I18nProvider';
import { printsReceipts, setPrintsReceipts } from './Receipt';

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
