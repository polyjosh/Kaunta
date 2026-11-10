import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { SyncPill } from '../components/SyncPill';
import { useSyncStatus } from '../sync/SyncProvider';
import type { Person } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import type { TFunction } from '../lib/I18nProvider';

export function Avatar({ person, size = 36 }: { person: Pick<Person, 'initial' | 'colour'>; size?: number }) {
  return (
    <span
      className="c-avatar"
      style={{ width: size, height: size, background: person.colour, fontSize: Math.round(size * 0.45) }}
      aria-hidden="true"
    >
      {person.initial}
    </span>
  );
}

/** The live sync pill; tapping it opens the sync screen from anywhere on the counter. */
export function CounterSyncPill() {
  const status = useSyncStatus();
  const navigate = useNavigate();
  return <SyncPill state={status.state} count={status.count} onClick={() => navigate('/counter/sync')} />;
}

/** 60px counter top bar: identity on the left, sync pill always visible on the right. */
export function TopBar({ children, trailing, compact = false }: { children: ReactNode; trailing?: ReactNode; compact?: boolean }) {
  return (
    <header className={`c-topbar${compact ? ' is-compact' : ''}`}>
      {children}
      <CounterSyncPill />
      {trailing}
    </header>
  );
}

interface SheetProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}

/** Bottom sheet over a scrim. Closes on the scrim, the close button or Escape. */
export function Sheet({ title, subtitle, onClose, children }: SheetProps) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="c-scrim" onClick={onClose} />
      <div className="c-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="c-sheet-grabber" />
        <div className="c-sheet-head">
          <div className="c-sheet-titles">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button ref={closeRef} type="button" className="c-icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="close" size={22} strokeWidth={2.4} />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

/** A clock that ticks, so "open 22 min" and ageing stay live without a reload. */
export function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** Back arrow + title, for the screens one step in from Sell. */
export function BackBar({ to, title, subtitle }: { to: string; title: ReactNode; subtitle?: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    // Inner screens use the smaller pill drawn in Orders / OrderDetail / Sync.dc.html.
    <TopBar compact>
      <button type="button" className="c-back-icon" aria-label={t('common.back')} onClick={() => navigate(to)}>
        <Icon name="chevron-left" size={24} strokeWidth={2.4} />
      </button>
      <div className="c-topbar-title">
        <h1>{title}</h1>
        {subtitle && <span>{subtitle}</span>}
      </div>
    </TopBar>
  );
}

const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0'];

/**
 * Whole-KES amount entry without the phone keyboard. `value` is the amount;
 * keys append digits, ⌫ removes the last one. Capped well below unsafe integers.
 */
export function NumberPad({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const { t } = useI18n();
  const press = (key: string) => {
    const next = Number(`${value}${key}`);
    if (next <= 9_999_999) onChange(next);
  };
  return (
    <div className="c-numpad">
      {PAD_KEYS.map((key) => (
        <button key={key} type="button" onClick={() => press(key)}>
          {key}
        </button>
      ))}
      <button type="button" aria-label={t('login.deleteDigit')} onClick={() => onChange(Math.floor(value / 10))}>
        ⌫
      </button>
    </div>
  );
}

export interface ToastMessage {
  text: string;
  /** A second line, e.g. "Saved on this phone…". */
  detail?: string;
  /** `warning` (yellow) for things an admin will look at; `offline` (grey) when saved locally. Never red. */
  tone?: 'ok' | 'warning' | 'offline';
  action?: { label: string; run: () => void };
}

/**
 * While offline, a confirmation also says the record is safe on this phone
 * and will sync later, in the calm offline colours (Components.dc.html).
 */
export function withOffline(message: ToastMessage, online: boolean, t: TFunction): ToastMessage {
  if (online || message.tone === 'warning') return message;
  return { ...message, tone: 'offline', detail: t('toast.savedOffline') };
}

const TOAST_ICON = { ok: 'check-circle', warning: 'alert-triangle', offline: 'cloud-off' } as const;

/**
 * One toast at a time, from the top so the thumb's area stays clear. Gone
 * after 4 seconds, or 10 when it offers an action such as Undo.
 */
export function Toast({ message, onDone }: { message: ToastMessage | string | null; onDone: () => void }) {
  const toast: ToastMessage | null = typeof message === 'string' ? { text: message } : message;
  const text = toast?.text;
  const hasAction = Boolean(toast?.action);

  useEffect(() => {
    if (!text) return;
    const timer = setTimeout(onDone, hasAction ? 10_000 : 4000);
    return () => clearTimeout(timer);
  }, [text, hasAction, onDone]);

  return (
    <div className="c-toast-slot" role="status">
      {toast && (
        <div className={`c-toast is-${toast.tone ?? 'ok'}`}>
          <Icon name={TOAST_ICON[toast.tone ?? 'ok']} size={24} />
          <span>
            {toast.text}
            {toast.detail && <small>{toast.detail}</small>}
          </span>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action?.run();
                onDone();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A toast carried to the next screen in the router's location state. */
export function toastFromState(state: unknown): ToastMessage | null {
  const toast = (state as { toast?: ToastMessage | string } | null)?.toast;
  return typeof toast === 'string' ? { text: toast } : (toast ?? null);
}
