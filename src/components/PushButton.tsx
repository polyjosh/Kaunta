import { usePush } from '../lib/push';
import { useI18n } from '../lib/I18nProvider';

/**
 * "Turn on notifications" (browsers only ask after a tap), or how they stand.
 * Shows nothing while push is not set up (no OneSignal app id, or the demo).
 */
export function PushButton({ className, onDone }: { className: string; onDone?: () => void }) {
  const { t } = useI18n();
  const { state, enable } = usePush();
  if (state === 'off') return null;
  if (state === 'ask') {
    return (
      <button
        type="button"
        className={className}
        onClick={() => {
          void enable().finally(() => onDone?.());
        }}
      >
        {t('push.enable')}
      </button>
    );
  }
  return <p className="k-push-state">{t(state === 'on' ? 'push.on' : state === 'blocked' ? 'push.blocked' : 'push.unsupported')}</p>;
}
