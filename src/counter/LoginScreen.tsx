import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, Logo } from '../components/Icon';
import { attemptLogin, checkResetCode, hasPinReset, setNewPin } from '../data/login';
import { useDb, useQuery } from '../data/react';
import { startShift } from '../data/shifts';
import { activeLock, lockCountdown } from '../domain/pin';
import type { Id, Instant, Person } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import { useSession } from './Session';
import { Avatar, TopBar } from './ui';

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

type View =
  | { name: 'names' }
  | { name: 'pin'; personId: Id }
  | { name: 'locked'; personId: Id; until: Instant }
  /** R-PIN-2: the one-time code from an admin, then the new PIN twice. */
  | { name: 'reset'; personId: Id }
  | { name: 'newPin'; personId: Id; first: string | null; mismatch?: boolean }
  /** No PIN yet and no code waiting: only an admin can help. */
  | { name: 'noPin'; personId: Id };

/** Screen 1: names → PIN → (locked). Rules R-PIN-1, R-PIN-2. */
export function LoginScreen() {
  const { t } = useI18n();
  const db = useDb();
  const session = useSession();
  const navigate = useNavigate();
  const [view, setView] = useState<View>({ name: 'names' });

  const bar = useQuery((d) => d.bar.toCollection().first());
  // Everyone who logs in with a PIN, locked or not: the lock shows on every device.
  const staff = useQuery(async (d) =>
    (await d.people.toArray())
      .filter((p) => p.login === 'pin' && !p.archived_at)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  const person = view.name === 'names' ? undefined : staff?.find((p) => p.id === view.personId);

  const pick = (p: Person) => {
    const now = new Date();
    const until = activeLock(p, now);
    if (until) setView({ name: 'locked', personId: p.id, until });
    else if (hasPinReset(p, now)) setView({ name: 'reset', personId: p.id });
    else if (!p.pin_hash) setView({ name: 'noPin', personId: p.id });
    else setView({ name: 'pin', personId: p.id });
  };
  const toNames = () => setView({ name: 'names' });

  return (
    <div className="c-screen">
      <TopBar>
        <Logo />
        <div className="c-topbar-id">
          <strong>{bar?.name}</strong>
          {session.device && <span>{t('login.device', { device: session.device.name })}</span>}
        </div>
      </TopBar>

      {view.name === 'names' && (
        <>
          <main className="c-body c-login-names">
            <div className="c-login-intro">
              <h1>{t('login.who')}</h1>
              <p>{t('login.whoHint')}</p>
            </div>
            <div className="c-staff-grid">
              {staff?.map((p) => (
                <button key={p.id} type="button" className="c-staff-tile" onClick={() => pick(p)}>
                  <Avatar person={p} size={56} />
                  <span>{p.name}</span>
                </button>
              ))}
            </div>
          </main>
          <footer className="c-login-foot">
            <button type="button" className="c-btn c-btn-outline" onClick={() => navigate('/admin')}>
              {t('login.admin')}
            </button>
          </footer>
        </>
      )}

      {view.name === 'pin' && person && (
        <PinPad
          key={person.id}
          person={person}
          onBack={toNames}
          onSubmit={(pin) => attemptLogin(db, session.device?.id ?? '', person.id, pin)}
          onLocked={(until) => setView({ name: 'locked', personId: person.id, until })}
          onSuccess={async () => {
            // Continue this person's shift on this phone, or open one, and pick up handed-over orders.
            await startShift(db, { person_id: person.id, device_id: session.device?.id ?? '' });
            session.login(person.id);
            navigate('/counter/sell', { replace: true });
          }}
        />
      )}

      {view.name === 'reset' && person && (
        <PinPad
          key={`reset-${person.id}`}
          person={person}
          length={6}
          prompt={t('login.reset.enterCode')}
          onBack={toNames}
          onSubmit={(code) => checkResetCode(db, session.device?.id ?? '', person.id, code)}
          onLocked={(until) => setView({ name: 'locked', personId: person.id, until })}
          wrongMessage={(left) => t('login.reset.wrongCode', { count: left })}
          onSuccess={async () => setView({ name: 'newPin', personId: person.id, first: null })}
        />
      )}

      {view.name === 'newPin' && person && (
        <PinPad
          key={`new-${person.id}-${view.first ?? ''}`}
          person={person}
          prompt={view.first === null ? t('login.reset.choose') : t('login.reset.again')}
          onBack={toNames}
          onSubmit={async (pin) => (view.first === null || pin === view.first ? { status: 'ok' } : { status: 'wrong', tries_left: 0 })}
          onLocked={() => undefined}
          initialMessage={view.mismatch ? t('login.reset.mismatch') : ''}
          onWrong={() => setView({ name: 'newPin', personId: person.id, first: null, mismatch: true })}
          onSuccess={async (pin) => {
            if (view.first === null) {
              setView({ name: 'newPin', personId: person.id, first: pin });
              return;
            }
            await setNewPin(db, session.device?.id ?? '', person.id, pin);
            await startShift(db, { person_id: person.id, device_id: session.device?.id ?? '' });
            session.login(person.id);
            navigate('/counter/sell', { replace: true });
          }}
        />
      )}

      {view.name === 'noPin' && person && (
        <main className="c-body c-locked">
          <div className="c-locked-card">
            <Avatar person={person} size={64} />
            <p className="c-locked-body">{t('login.reset.noPin', { name: person.name })}</p>
          </div>
          <div className="c-locked-actions">
            <button type="button" className="c-btn c-btn-secondary" onClick={toNames}>
              {t('login.another')}
            </button>
          </div>
        </main>
      )}

      {view.name === 'locked' && person && (
        <Locked
          person={person}
          until={view.until}
          onExpired={() => setView({ name: 'pin', personId: person.id })}
          onBack={toNames}
        />
      )}
    </div>
  );
}

interface PinPadProps {
  person: Person;
  onBack: () => void;
  onSubmit: (pin: string) => ReturnType<typeof attemptLogin>;
  onLocked: (until: Instant) => void;
  onSuccess: (pin: string) => Promise<void>;
  /** 4 for a PIN, 6 for an admin's one-time code. */
  length?: number;
  prompt?: string;
  wrongMessage?: (triesLeft: number) => string;
  onWrong?: () => void;
  /** Shown before any key is pressed, e.g. why the PIN has to be chosen again. */
  initialMessage?: string;
}

function PinPad({ person, onBack, onSubmit, onLocked, onSuccess, length = 4, prompt, wrongMessage, onWrong, initialMessage = '' }: PinPadProps) {
  const { t } = useI18n();
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState(initialMessage);
  const checking = useRef(false);

  const press = async (digit: string) => {
    if (checking.current || pin.length >= length) return;
    const next = pin + digit;
    setPin(next);
    if (next.length < length) return;

    // The last digit submits by itself.
    checking.current = true;
    try {
      const result = await onSubmit(next);
      if (result.status === 'ok') {
        if (!prompt) setMessage(t('login.welcome'));
        await onSuccess(next);
        return;
      }
      if (result.status === 'locked') {
        onLocked(result.until);
        return;
      }
      setPin('');
      setMessage(wrongMessage ? wrongMessage(result.tries_left) : t('login.wrongPin', { count: result.tries_left }));
      onWrong?.();
    } finally {
      checking.current = false;
    }
  };

  return (
    <main className="c-body c-pin">
      <button type="button" className="c-back" onClick={onBack}>
        <Icon name="chevron-left" size={20} strokeWidth={2.4} />
        {t('login.notMe')}
      </button>
      <div className="c-pin-who">
        <Avatar person={person} size={64} />
        <h1>{person.name}</h1>
        <p>{prompt ?? t('login.enterPin')}</p>
      </div>
      <div className="c-pin-dots" aria-hidden="true">
        {Array.from({ length }, (_, i) => i).map((i) => (
          <span key={i} className={i < pin.length ? 'is-filled' : undefined} />
        ))}
      </div>
      <p className="c-pin-message" aria-live="polite">
        {message}
      </p>
      <div className="c-keypad">
        {DIGITS.map((d) => (
          <button key={d} type="button" className="c-key" onClick={() => void press(d)}>
            {d}
          </button>
        ))}
        <span />
        <button type="button" className="c-key" onClick={() => void press('0')}>
          0
        </button>
        <button
          type="button"
          className="c-key c-key-plain"
          aria-label={t('login.deleteDigit')}
          onClick={() => !checking.current && setPin(pin.slice(0, -1))}
        >
          ⌫
        </button>
      </div>
    </main>
  );
}

interface LockedProps {
  person: Person;
  until: Instant;
  onExpired: () => void;
  onBack: () => void;
}

function Locked({ person, until, onExpired, onBack }: LockedProps) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Ends when the timer runs out, or as soon as an admin's unlock reaches this phone.
  // (A cleared lock has no attempts left on it; a not-yet-refreshed record still has some.)
  const unlocked = person.pin_locked_until === null && person.failed_pin_attempts === 0;
  const over = Date.parse(until) <= now.getTime() || unlocked;
  useEffect(() => {
    if (over) onExpired();
  }, [over, onExpired]);

  return (
    <main className="c-body c-locked">
      <div className="c-locked-card">
        <span className="c-locked-icon">
          <Icon name="lock" size={34} />
        </span>
        <p className="c-locked-chip">{t('login.lockedChip')}</p>
        <p className="c-locked-time" role="timer">
          {lockCountdown(until, now)}
        </p>
        <p className="c-locked-body">{t('login.lockedBody', { name: person.name })}</p>
      </div>
      <div className="c-locked-actions">
        <button type="button" className="c-btn c-btn-secondary" onClick={onBack}>
          {t('login.another')}
        </button>
        {/* An admin unlocks from Staff & devices; the unlock reaches this phone with the next sync. */}
        <a className="c-btn c-btn-link" href="/admin/staff">
          {t('login.adminUnlock')}
        </a>
      </div>
    </main>
  );
}
