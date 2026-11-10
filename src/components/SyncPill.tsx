import { Icon } from './Icon';
import type { IconName } from './Icon';
import type { Tone } from './StatusChip';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';
import type { SyncState } from '../lib/sync';

/** R-SYNC-2. Offline is calm grey, needs-admin is yellow, and nothing here is ever red. */
export const SYNC: Record<SyncState, { tone: Tone; icon: IconName; label: MessageKey }> = {
  synced: { tone: 'paid', icon: 'cloud-check', label: 'sync.synced' },
  waiting: { tone: 'pending', icon: 'cloud-up', label: 'sync.waiting' },
  sending: { tone: 'pending', icon: 'sending', label: 'sync.sending' },
  offline: { tone: 'offline', icon: 'cloud-off', label: 'sync.offline' },
  needsAdmin: { tone: 'warning', icon: 'alert-triangle', label: 'sync.needsAdmin' },
};

interface SyncPillProps {
  state: SyncState;
  count?: number;
  /** Opens the sync screen. */
  onClick?: () => void;
}

export function SyncPill({ state, count = 0, onClick }: SyncPillProps) {
  const { t } = useI18n();
  const { tone, icon, label } = SYNC[state];
  return (
    <button type="button" className={`k-sync-pill k-tone-${tone}`} data-sync={state} onClick={onClick}>
      <Icon name={icon} size={20} />
      <span>{t(label, { count })}</span>
    </button>
  );
}
