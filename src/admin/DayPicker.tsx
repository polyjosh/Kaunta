import { useRef } from 'react';
import { Icon } from '../components/Icon';
import type { BusinessDay } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import { dayLabel, shiftDay } from './data';

/** Admin keeps this many business days of sales on the device (admin_pull's window). */
export const DAYS_KEPT = 35;

/**
 * A calendar button that opens the browser's date picker, for loading another
 * business day (Today, Reconcile). Days from DAYS_KEPT ago up to today.
 */
export function DayPicker({ day, today, onPick }: { day: BusinessDay; today: BusinessDay; onPick: (day: BusinessDay) => void }) {
  const { t, locale } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const min = shiftDay(today, -DAYS_KEPT);
  const open = () => {
    const el = input.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      // Older browsers: the field itself takes the date.
      el.focus();
      el.click();
    }
  };
  return (
    <span className="a-daypick">
      <button type="button" className="a-btn a-btn-sm a-daypick-btn" onClick={open} aria-label={t('admin.day.pick', { date: dayLabel(day, locale) })}>
        <Icon name="calendar" size={18} />
        <span>{dayLabel(day, locale)}</span>
      </button>
      <input
        ref={input}
        className="a-daypick-input"
        type="date"
        tabIndex={-1}
        aria-label={t('admin.day.pickField')}
        min={min}
        max={today}
        value={day}
        onChange={(e) => {
          const picked = e.target.value;
          if (/^\d{4}-\d{2}-\d{2}$/.test(picked) && picked >= min && picked <= today) onPick(picked);
        }}
      />
    </span>
  );
}
