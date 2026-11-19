import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icon, Logo } from '../components/Icon';
import { useCounterBar } from './DemoCounterGate';
import { attemptLogin, loginSignedInAdmin, signsInAtCounter } from '../data/login';
import { useDb, useQuery } from '../data/react';
import { openShiftOf, startShift } from '../data/shifts';
import { activeLock, lockCountdown } from '../domain/pin';
import type { Id, Instant, Person } from '../domain/types';
import { adminHere } from '../lib/adminHere';
import { useI18n } from '../lib/I18nProvider';
import { formatAmount, formatKES } from '../lib/money';
import { useSession } from './Session';
import { Avatar, NumberPad, TopBar } from './ui';

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

type View =
  | { name: 'names' }
  | { name: 'pin'; personId: Id }
  /** Owners type their password. */
  | { name: 'password'; personId: Id }
  | { name: 'locked'; personId: Id; until: Instant }
  /** No PIN yet: only an owner or manager can set one. */
  | { name: 'noPin'; personId: Id }
  /** Signed in with no open shift on this phone: the cash float first. */
  | { name: 'float'; personId: Id };

const runsTheBar = (p: Person) => p.role === 'owner' || p.role === 'admin';

/**
 * Screen 1: names → PIN (or an owner's password) → (locked). Rules R-PIN-1.
 * Counter staff first, then the bar's owner and managers, who can sell too.
 * Whoever is signed in to admin on this browser goes straight in.
 */
export function LoginScreen() {
  const { t } = useI18n();
  const db = useDb();
  const session = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [view, setView] = useState<View>({ name: 'names' });

  const bar = useQuery((d) => d.bar.toCollection().first());
  // Everyone who logs in here, locked or not (the lock shows on every device); not anyone suspended.
  const staff = useQuery(async (d) =>
    (await d.people.toArray())
      .filter(signsInAtCounter)
      .sort((a, b) => Number(runsTheBar(a)) - Number(runsTheBar(b)) || a.name.localeCompare(b.name)),
  );
  const person = view.name === 'names' ? undefined : staff?.find((p) => p.id === view.personId);
  const here = adminHere();
  const signedInHere = (p: Person) => !!bar && here?.bar_id === bar.id && here.person_id === p.id && runsTheBar(p);

  const deviceId = session.device?.id ?? '';
  const begin = async (p: Person, floatKes?: number) => {
    // A shift belongs to this phone: never start one before the phone's own record has loaded.
    if (!deviceId) return;
    // Continue this person's shift on this phone, or open one, and pick up handed-over orders.
    await startShift(db, { person_id: p.id, device_id: deviceId }, floatKes);
    session.login(p.id);
    navigate('/counter/sell', { replace: true });
  };
  // A new shift starts by counting the float into the drawer; an open one carries on.
  const enter = async (p: Person) => {
    if (!deviceId) return;
    if (await openShiftOf(db, p.id, deviceId)) return begin(p);
    setView({ name: 'float', personId: p.id });
  };

  const pick = async (p: Person) => {
    session.clearRemoved();
    const until = activeLock(p, new Date());
    if (signedInHere(p) && (await loginSignedInAdmin(db, session.device?.id ?? '', p.id))) return enter(p);
    if (until) setView({ name: 'locked', personId: p.id, until });
    else if (!p.pin_hash) setView({ name: 'noPin', personId: p.id });
    else setView(p.login === 'password' ? { name: 'password', personId: p.id } : { name: 'pin', personId: p.id });
  };
  const toNames = () => setView({ name: 'names' });
  const counterBar = useCounterBar();

  // "Sell at the counter" from admin: straight in as that owner or manager.
  const fromAdmin = params.get('from') === 'admin';
  const handed = useRef(false);
  useEffect(() => {
    if (!fromAdmin || handed.current || !staff || !bar || !session.device) return;
    handed.current = true;
    const me = staff.find(signedInHere);
    if (me) void pick(me);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromAdmin, staff, bar, session.device]);

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
            {session.removed && (
              <p className="c-login-removed" role="status">
                {t('login.removed', { name: session.removed.name })}
              </p>
            )}
            {staff && staff.length === 0 && <p className="c-login-empty">{t('login.noStaff')}</p>}
            <div className="c-staff-grid" aria-busy={!session.device}>
              {session.device && staff?.map((p) => (
                <button key={p.id} type="button" className="c-staff-tile" onClick={() => void pick(p)}>
                  <Avatar person={p} size={56} />
                  <span>{p.name}</span>
                  {runsTheBar(p) && <small className="c-staff-role">{t(p.role === 'owner' ? 'login.role.owner' : 'login.role.manager')}</small>}
                </button>
              ))}
            </div>
          </main>
          <footer className="c-login-foot">
            <button type="button" className="c-btn c-btn-outline" onClick={() => navigate('/admin')}>
              {t('login.admin')}
            </button>
            {counterBar && (
              <button type="button" className="c-btn c-btn-link c-login-change" onClick={counterBar.changeBar}>
                {t('bar.change')}
              </button>
            )}
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
          onSuccess={() => enter(person)}
        />
      )}

      {view.name === 'password' && person && (
        <PasswordForm
          key={person.id}
          person={person}
          onBack={toNames}
          onSubmit={(password) => attemptLogin(db, session.device?.id ?? '', person.id, password)}
          onLocked={(until) => setView({ name: 'locked', personId: person.id, until })}
          onSuccess={() => enter(person)}
        />
      )}

      {view.name === 'noPin' && person && (
        <main className="c-body c-locked">
          <div className="c-locked-card">
            <Avatar person={person} size={64} />
            <p className="c-locked-body">{t('login.noPin', { name: person.name })}</p>
          </div>
          <div className="c-locked-actions">
            <button type="button" className="c-btn c-btn-secondary" onClick={toNames}>
              {t('login.another')}
            </button>
          </div>
        </main>
      )}

      {view.name === 'float' && person && <StartShift key={person.id} person={person} onBack={toNames} onStart={(floatKes) => begin(person, floatKes)} />}

      {view.name === 'locked' && person && (
        <Locked
          person={person}
          until={view.until}
          onExpired={() => setView(person.login === 'password' ? { name: 'password', personId: person.id } : { name: 'pin', personId: person.id })}
          onBack={toNames}
        />
      )}
    </div>
  );
}

/** The cash in the drawer when the shift starts: the float the close is counted against (R-SHIFT-2). */
function StartShift({ person, onBack, onStart }: { person: Person; onBack: () => void; onStart: (floatKes: number) => Promise<void> }) {
  const { t } = useI18n();
  const [float, setFloat] = useState(0);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onStart(float);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <main className="c-body c-shift c-float">
        <div className="c-login-intro">
          <h1>{t('float.title', { name: person.name })}</h1>
          <p>{t('float.hint')}</p>
        </div>
        <div className="c-field">
          <span className="c-field-label" id="float-amount">
            {t('float.label')}
          </span>
          <div className="c-amount-display" aria-live="polite" aria-labelledby="float-amount">
            <span>KES</span>
            <strong>{formatAmount(float)}</strong>
          </div>
        </div>
        <NumberPad value={float} onChange={setFloat} />
      </main>
      <footer className="c-bottom c-bottom-stack">
        <button type="button" className="c-btn c-btn-primary" disabled={busy} onClick={() => void start()}>
          {float > 0 ? t('float.start', { amount: formatKES(float) }) : t('float.startNone')}
        </button>
        <button type="button" className="c-btn c-btn-link" onClick={onBack}>
          {t('login.another')}
        </button>
      </footer>
    </>
  );
}

interface PasswordFormProps {
  person: Person;
  onBack: () => void;
  onSubmit: (password: string) => ReturnType<typeof attemptLogin>;
  onLocked: (until: Instant) => void;
  onSuccess: () => Promise<void>;
}

/** An owner signs in at the counter with the password they use for admin. */
function PasswordForm({ person, onBack, onSubmit, onLocked, onSuccess }: PasswordFormProps) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    try {
      const result = await onSubmit(password);
      if (result.status === 'ok') return await onSuccess();
      if (result.status === 'locked') return onLocked(result.until);
      setPassword('');
      setMessage(t('login.wrongPassword', { count: result.tries_left }));
    } finally {
      setBusy(false);
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
        <p>{t('login.enterPassword')}</p>
      </div>
      <form className="c-password" onSubmit={submit}>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          aria-label={t('login.password')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="c-pin-message" aria-live="polite">
          {message}
        </p>
        <button type="submit" className="c-btn c-btn-primary" disabled={busy || !password}>
          {t('login.signIn')}
        </button>
      </form>
    </main>
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
