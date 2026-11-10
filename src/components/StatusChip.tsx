import { Icon } from './Icon';
import type { IconName } from './Icon';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';

export type Status =
  | 'paid'
  | 'pending'
  | 'partPaid'
  | 'voided'
  | 'writtenOff'
  | 'outOfStock'
  | 'offline'
  | 'needsReview'
  | 'short'
  | 'over'
  | 'matches';

export type Tone = 'paid' | 'pending' | 'warning' | 'error' | 'written-off' | 'neutral' | 'offline';

/** Every status is colour + icon + label. Ember is never a status. */
export const STATUS: Record<Status, { tone: Tone; icon: IconName; label: MessageKey }> = {
  paid: { tone: 'paid', icon: 'check-circle', label: 'status.paid' },
  pending: { tone: 'pending', icon: 'clock', label: 'status.pending' },
  partPaid: { tone: 'pending', icon: 'pie', label: 'status.partPaid' },
  voided: { tone: 'neutral', icon: 'ban', label: 'status.voided' },
  writtenOff: { tone: 'written-off', icon: 'archive', label: 'status.writtenOff' },
  outOfStock: { tone: 'neutral', icon: 'box', label: 'status.outOfStock' },
  offline: { tone: 'offline', icon: 'cloud-off', label: 'status.offline' },
  needsReview: { tone: 'warning', icon: 'alert-triangle', label: 'status.needsReview' },
  short: { tone: 'error', icon: 'x-circle', label: 'status.short' },
  over: { tone: 'pending', icon: 'arrow-up-circle', label: 'status.over' },
  matches: { tone: 'paid', icon: 'check-circle', label: 'status.matches' },
};

interface StatusChipProps {
  status: Status;
  /** Replaces the default label when the chip carries detail, e.g. "46 min · open long". */
  children?: React.ReactNode;
  className?: string;
}

export function StatusChip({ status, children, className }: StatusChipProps) {
  const { t } = useI18n();
  const { tone, icon, label } = STATUS[status];
  return (
    <span className={`k-chip k-tone-${tone}${className ? ` ${className}` : ''}`} data-status={status}>
      <Icon name={icon} size={18} />
      <span>{children ?? t(label)}</span>
    </span>
  );
}
