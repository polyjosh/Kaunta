import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { seedAdminDatabase } from '../data/adminSeed';
import { KauntaDB } from '../data/db';
import { DbProvider } from '../data/react';
import { useI18n } from '../lib/I18nProvider';
import { accountAudience, pushAs } from '../lib/push';
import { useDemoServer } from '../data/demoServer';
import { businessDayOf } from '../domain/time';
import type { MessageKey } from '../lib/i18n';
import { serverConfig } from '../sync/config';
import type { ServerConfig } from '../sync/config';
import { AdminServer, AdminSync, applyAdminPull } from './server';
import type { AccountMe } from './server';
import { refreshPlatform, setPlatformServer } from '../platform/actions';
import { hashSecret } from '../domain/pin';
import { AdminSessionProvider, useAdmin } from './AdminSession';
import type { AccountChoice, BarChoice } from './AdminSession';
import { NoBars, OwnerSignIn } from './OwnerSignIn';
import { accountById, barLimit, barsFor, changeSecret, createBar as createPlatformBar, DEMO_OWNER, ownerSession, setOwnerSession, setSuperViewBar, superViewBar, superViewRequest, suspendedBarsFor, usePlatform } from '../platform/platform';
import type { Account } from '../platform/platform';
import { BarPicker } from './BarSwitcher';
import {
  cacheBars,
  cachedBars,
  DEMO_SAMPLE_BAR,
  demoStore,
  ensureMemberPeople,
  liveStoreName,
  newDemoBarCode,
  rememberBar,
  rememberDemoBar,
  rememberedBar,
  rememberedDemoBar,
  seedNewDemoBar,
  syncAccountPeople,
} from './bars';
import type { BarSummary } from './bars';
import { AccountScreen } from './AccountScreen';
import { ApprovalsScreen } from './ApprovalsScreen';
import { AuditScreen } from './AuditScreen';
import { FeedScreen } from './FeedScreen';
import { KegsScreen } from './KegsScreen';
import { ProductEditorScreen, ProductsScreen } from './ProductScreens';
import { ReconcileScreen } from './ReconcileScreen';
import { StaffScreen } from './StaffScreen';
import { StockScreen } from './StockScreen';
import { TodayScreen } from './TodayScreen';
import './admin.css';

function ReconcileToday() {
  const { now } = useAdmin();
  return <Navigate to={`/admin/reconcile/${businessDayOf(now())}`} replace />;
}

function ReconcileDay() {
  const { day } = useParams();
  return /^\d{4}-\d{2}-\d{2}$/.test(day ?? '') ? <ReconcileScreen day={day!} /> : <ReconcileToday />;
}

export function AdminRoutes() {
  return (
    <Routes>
      <Route index element={<TodayScreen />} />
      <Route path="sales" element={<FeedScreen />} />
      <Route path="approvals" element={<ApprovalsScreen />} />
      <Route path="reconcile" element={<ReconcileToday />} />
      <Route path="reconcile/:day" element={<ReconcileDay />} />
      <Route path="products" element={<ProductsScreen />} />
      <Route path="products/:id" element={<ProductEditorScreen />} />
      <Route path="stock/new" element={<StockScreen />} />
      <Route path="kegs" element={<KegsScreen />} />
      <Route path="staff" element={<StaffScreen />} />
      <Route path="audit" element={<AuditScreen />} />
      <Route path="account" element={<AccountScreen />} />
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}

interface AdminAppProps {
  /** For tests: an admin store to use instead of the demo one. */
  db?: KauntaDB;
  /** The Supabase project. Defaults to `.env.local`; `null` runs the demo. */
  config?: ServerConfig | null;
  /** For tests: talk to this instead of Supabase. */
  server?: AdminServer;
}

/**
 * /admin/*: the admin and owner screens. They read only from their own
 * local store, like the counter, so they work with a poor connection.
 * Without a server this is a demo on the sample day, signed in as the owner.
 */
export function AdminApp({ db, config = serverConfig(), server }: AdminAppProps) {
  if (server || config) {
    // Kaunta opened a bar from /super (signed in to the server as Kaunta): that bar, as Kaunta.
    const kaunta = config && !server ? new AdminServer(config, undefined, undefined, true) : null;
    const view = superViewRequest();
    if (kaunta?.signedIn && view) return <KauntaLiveBar server={kaunta} barId={view} db={db} />;
    return <AdminLive server={server ?? new AdminServer(config!)} db={db} />;
  }
  return <AdminDemo db={db} />;
}

type LiveState = 'signedOut' | 'bars' | 'pick' | 'loading' | 'ready' | 'suspended';

const byName = (a: BarSummary, b: BarSummary) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * With a server: sign in, find the bars this sign-in runs (admin_bars), open
 * one, fill its admin store from admin_pull, then keep it in step
 * (AdminSync). Each bar has its own store on this browser; all of them are
 * wiped on sign-out.
 */
function AdminLive({ server: given, db }: { server: AdminServer; db?: KauntaDB }) {
  const { locale } = useI18n();
  const [server] = useState(given);
  const [bars, setBars] = useState<BarSummary[]>([]);
  const [barId, setBarId] = useState<string | null>(null);
  const [store, setStore] = useState<KauntaDB | null>(null);
  const [state, setState] = useState<LiveState>(server.signedIn ? 'bars' : 'signedOut');
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const [me, setMe] = useState<string | null>(null);
  // The signed-in account (server accounts): limits, bars suspended, changing the password or PIN.
  const [who, setWho] = useState<AccountMe | null>(null);

  const fail = useCallback(
    (error: unknown) => {
      server.signOut();
      setNotice((error as Error).message === 'not_admin' ? 'admin.signIn.notAdmin' : 'admin.signIn.offline');
      setState('signedOut');
    },
    [server],
  );

  const open = useCallback(
    (id: string) => {
      rememberBar(id);
      setMe(null);
      setBarId(id);
      setStore(db ?? new KauntaDB(liveStoreName(id)));
      setState('loading');
    },
    [db],
  );

  // Which bars: from the server, or (no connection) the list from last time.
  useEffect(() => {
    if (state !== 'bars') return;
    let cancelled = false;
    void (async () => {
      let list: BarSummary[];
      try {
        const [bars, account] = await Promise.all([server.bars(), server.me().catch(() => null)]);
        list = [...bars].sort(byName);
        cacheBars(list);
        if (account && !cancelled) {
          setWho(account);
          // The owner's platform (their managers), for Staff & devices → Managers.
          setPlatformServer(server);
          await refreshPlatform().catch(() => {});
        }
        if (list.length === 0 && account?.suspended.length) {
          if (!cancelled) setState('suspended');
          return;
        }
      } catch (error) {
        const cached = cachedBars();
        if (!(error as Error).message.startsWith('network') || !cached?.length) {
          if (!cancelled) fail(error);
          return;
        }
        list = cached;
      }
      if (cancelled) return;
      if (list.length === 0) return fail(new Error('not_admin'));
      setBars(list);
      const pick = rememberedBar(list) ?? (list.length === 1 ? list[0]!.id : null);
      if (pick) open(pick);
      else setState('pick');
    })();
    return () => {
      cancelled = true;
    };
  }, [state, server, fail, open]);

  // The open bar's store: what this browser already has, or a first pull.
  useEffect(() => {
    if (state !== 'loading' || !store || !barId) return;
    let cancelled = false;
    void (async () => {
      const known = (await store.meta.get('me'))?.value as string | undefined;
      if (known) {
        // Start from what this browser already has; the sync brings it up to date.
        if (!cancelled) {
          setMe(known);
          setState('ready');
        }
        return;
      }
      try {
        const data = await server.forBar(barId).pull(null);
        await applyAdminPull(store, data);
        if (!cancelled) {
          setMe(data.me);
          setState('ready');
        }
      } catch (error) {
        if (!cancelled) fail(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, server, store, barId, fail]);

  const barServer = useMemo(() => (barId ? server.forBar(barId) : null), [server, barId]);

  useEffect(() => {
    if (state !== 'ready' || !store || !barServer) return;
    const sync = new AdminSync(store, barServer);
    sync.start();
    return () => sync.stop();
  }, [state, store, barServer]);

  // Owners and managers receive their bars' notifications as their account, on every browser they sign in on.
  const accountId = who?.account.id;
  useEffect(() => {
    if (accountId) void pushAs(accountAudience(accountId), locale);
  }, [accountId, locale]);

  const signOut = useCallback(() => {
    void pushAs(null);
    server.signOut();
    setPlatformServer(null);
    setWho(null);
    setMe(null);
    setNotice(null);
    setState('signedOut');
    setStore(null);
    setBarId(null);
    rememberBar(null);
    cacheBars(null);
    // This browser keeps nothing of any bar once signed out.
    const names = new Set([...bars.map((b) => liveStoreName(b.id)), 'kaunta-admin']);
    if (db) void db.delete();
    else for (const name of names) void new KauntaDB(name).delete();
  }, [server, bars, db]);

  const createBar = useCallback(
    async (name: string) => {
      const bar = await server.createBar(name);
      const list = [...bars.filter((b) => b.id !== bar.id), bar].sort(byName);
      setBars(list);
      cacheBars(list);
      setWho(await server.me().catch(() => who));
      await refreshPlatform().catch(() => {});
      open(bar.id);
    },
    [server, bars, open, who],
  );

  const changeBarCode = useCallback(
    async (wanted?: string) => {
      if (!barServer || !store || !barId) throw new Error('No bar open');
      const result = await barServer.changeBarCode(wanted);
      if ('error' in result) return result;
      // The server's row says the same on the next pull; show it now.
      await store.bar.update(barId, { counter_code: result.code });
      const list = bars.map((b) => (b.id === barId ? { ...b, counter_code: result.code } : b));
      setBars(list);
      cacheBars(list);
      return result;
    },
    [barServer, store, barId, bars],
  );

  const owner = bars.some((b) => b.role === 'owner');
  const choice = useMemo<BarChoice | null>(
    () => (barId ? { bars, barId, switchBar: open, createBar: owner ? createBar : undefined, changeBarCode, barLimit: owner ? who?.bar_limit : undefined } : null),
    [bars, barId, open, owner, createBar, changeBarCode, who],
  );
  const account = useMemo<AccountChoice | undefined>(
    () =>
      who
        ? {
            id: who.account.id,
            username: who.account.username,
            secret: who.account.secret,
            pinSetByKaunta: who.account.pin_set_by === 'kaunta',
            changePin: async (current, next) => {
              const answer = await server.changeSecret(current, next, await hashSecret(next || '-'));
              if ('error' in answer) return answer.error as 'current' | 'invalid' | 'same';
              setWho({ ...who, account: { ...who.account, pin_set_by: 'self' } });
              return null;
            },
          }
        : undefined,
    [who, server],
  );

  if (state === 'signedOut') return <OwnerSignIn signIn={(username, secret) => server.signIn(username, secret)} notice={notice} onSignedIn={() => setState('bars')} />;
  if (state === 'suspended') return <NoBars onSignOut={signOut} suspended={who?.suspended ?? []} />;
  if (state === 'pick') return <BarPicker bars={bars} onPick={open} onSignOut={signOut} />;
  if (state !== 'ready' || !me || !store || !barServer || !choice) return <div className="a-app" aria-busy="true" />;
  return (
    <DbProvider key={barId} db={store} demo={false}>
      <AdminSessionProvider personId={me} signOut={signOut} createPairingCode={barServer.createPairingCode} bars={choice} account={account}>
        <AdminRoutes />
      </AdminSessionProvider>
    </DbProvider>
  );
}

/**
 * Kaunta on the server, in one bar's admin (opened from /super): pulled and
 * kept in step as Kaunta, every owner tab, even while the bar is suspended.
 */
function KauntaLiveBar({ server: given, barId, db }: { server: AdminServer; barId: string; db?: KauntaDB }) {
  const [server] = useState(given);
  const [store] = useState(() => db ?? new KauntaDB(`kaunta-super-admin-${barId}`));
  const barServer = useMemo(() => server.forBar(barId), [server, barId]);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState('');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const since = ((await store.meta.get('pull_cursor'))?.value as string | undefined) ?? null;
      try {
        await applyAdminPull(store, await barServer.pull(since));
      } catch {
        // Offline: what this browser has.
      }
      const bar = await store.bar.get(barId);
      if (!cancelled) {
        setName(bar?.name ?? '');
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store, barServer, barId]);
  useEffect(() => {
    if (!ready) return;
    const sync = new AdminSync(store, barServer);
    sync.start();
    return () => sync.stop();
  }, [ready, store, barServer]);
  const back = useCallback(() => {
    setSuperViewBar(null);
    window.location.assign(`/super/bars/${barId}`);
  }, [barId]);
  const choice = useMemo<BarChoice>(
    () => ({ bars: [{ id: barId, name, role: 'owner', counter_code: '' }], barId, switchBar: () => {}, changeBarCode: barServer.changeBarCode }),
    [barId, name, barServer],
  );
  if (!ready) return <div className="a-app" aria-busy="true" />;
  return (
    <DbProvider key={barId} db={store} demo={false}>
      <AdminSessionProvider asKaunta signOut={back} createPairingCode={barServer.createPairingCode} bars={choice}>
        <AdminRoutes />
      </AdminSessionProvider>
    </DbProvider>
  );
}

/**
 * Without a server (demo): owners sign in with a username and password,
 * managers with a username and PIN (accounts Kaunta created at /super), then
 * see only their bars. Each bar has its own store in this browser.
 */
function AdminDemo({ db }: { db?: KauntaDB }) {
  const p = usePlatform();
  // Kaunta opened a bar from /super: that bar, every tab, as Kaunta.
  const [kauntaBar, setKauntaBar] = useState<string | null>(() => (db ? null : superViewBar()));
  // A store handed in (tests) is the sample bar's, opened as its owner.
  const [accountId, setAccountId] = useState<string | null>(() => (db ? DEMO_OWNER.id : ownerSession()));
  const account = accountById(accountId, p);
  const signOut = useCallback(() => {
    setOwnerSession(null);
    setAccountId(null);
  }, []);
  if (kauntaBar && p.bars.some((b) => b.id === kauntaBar)) {
    return (
      <KauntaBar
        barId={kauntaBar}
        onBack={() => {
          setSuperViewBar(null);
          setKauntaBar(null);
          window.location.assign(`/super/bars/${kauntaBar}`);
        }}
      />
    );
  }
  if (!account) {
    return (
      <OwnerSignIn
        onSignedIn={(id) => {
          setOwnerSession(id);
          setAccountId(id);
        }}
      />
    );
  }
  return <DemoBars key={account.id} account={account} db={db} onSignOut={signOut} />;
}

function DemoBars({ account, db, onSignOut }: { account: Account; db?: KauntaDB; onSignOut: () => void }) {
  const p = usePlatform();
  const bars = useMemo<BarSummary[]>(() => barsFor(account.id, p), [p, account.id]);
  const [barId, setBarId] = useState(() =>
    db && bars.some((b) => b.id === DEMO_SAMPLE_BAR) ? DEMO_SAMPLE_BAR : (rememberedDemoBar(bars) ?? bars[0]?.id ?? null),
  );
  const bar = bars.find((b) => b.id === barId) ?? bars[0] ?? null;
  const store = bar ? (bar.id === DEMO_SAMPLE_BAR && db ? db : demoStore(bar.id)) : null;
  const seed = useMemo(
    () =>
      bar?.id === DEMO_SAMPLE_BAR
        ? async (d: KauntaDB) => {
            await seedAdminDatabase(d);
            await ensureMemberPeople(d, DEMO_SAMPLE_BAR);
          }
        : (d: KauntaDB) => seedNewDemoBar(d, bar!),
    [bar],
  );

  useDemoServer(store, !!bar && bar.id !== DEMO_SAMPLE_BAR);

  const switchBar = useCallback((id: string) => {
    rememberDemoBar(id);
    setBarId(id);
  }, []);
  const ownsABar = bars.some((b) => b.role === 'owner');
  const limit = barLimit(account.id, p);
  const createBar = useCallback(
    async (name: string) => {
      const made = createPlatformBar(account.id, name);
      if ('error' in made) throw new Error(made.error);
      switchBar(made.bar.id);
    },
    [account.id, switchBar],
  );
  const changeBarCode = useCallback(async (code?: string) => (bar ? newDemoBarCode(bar.id, code) : { error: 'invalid' as const }), [bar]);
  const choice = useMemo<BarChoice | null>(
    () => (bar ? { bars, barId: bar.id, switchBar, createBar: ownsABar ? createBar : undefined, changeBarCode, barLimit: ownsABar ? limit : undefined } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- limit follows `p`
    [bars, bar, switchBar, ownsABar, createBar, changeBarCode, limit.used, limit.max],
  );
  const accountChoice = useMemo<AccountChoice>(
    () => ({
      id: account.id,
      username: account.username,
      secret: account.secret,
      pinSetByKaunta: account.pin_set_by === 'kaunta',
      changePin: async (current, next) => {
        const problem = await changeSecret(account.id, current, next);
        // Their counters take the new password or PIN too.
        if (!problem) await syncAccountPeople(account.id);
        return problem;
      },
    }),
    [account],
  );

  if (!bar || !store || !choice) return <NoBars onSignOut={onSignOut} suspended={suspendedBarsFor(account.id, p).map((b) => b.name)} />;
  return (
    <DbProvider key={bar.id} db={store} demo seed={seed}>
      <AdminSessionProvider personId={account.person_id} signOut={onSignOut} bars={choice} account={accountChoice}>
        <AdminRoutes />
      </AdminSessionProvider>
    </DbProvider>
  );
}

/**
 * Kaunta (the super admin, signed in at /super) in one bar's admin: every tab
 * the owner has, as Kaunta, even while the bar is suspended. Kaunta's actions
 * are audited as Kaunta and left out of what owners and managers see.
 */
function KauntaBar({ barId, onBack }: { barId: string; onBack: () => void }) {
  const p = usePlatform();
  const found = p.bars.find((b) => b.id === barId)!;
  const bar = useMemo<BarSummary>(() => ({ id: found.id, name: found.name, role: 'owner', counter_code: found.counter_code }), [found.id, found.name, found.counter_code]);
  const store = demoStore(bar.id);
  const seed = useMemo(
    () =>
      bar.id === DEMO_SAMPLE_BAR
        ? async (d: KauntaDB) => {
            await seedAdminDatabase(d);
            await ensureMemberPeople(d, DEMO_SAMPLE_BAR);
          }
        : (d: KauntaDB) => seedNewDemoBar(d, bar),
    [bar],
  );
  useDemoServer(store, bar.id !== DEMO_SAMPLE_BAR);
  const changeBarCode = useCallback(async (code?: string) => newDemoBarCode(bar.id, code), [bar.id]);
  const choice = useMemo<BarChoice>(() => ({ bars: [bar], barId: bar.id, switchBar: () => {}, changeBarCode }), [bar, changeBarCode]);
  return (
    <DbProvider key={bar.id} db={store} demo seed={seed}>
      <AdminSessionProvider asKaunta signOut={onBack} bars={choice}>
        <AdminRoutes />
      </AdminSessionProvider>
    </DbProvider>
  );
}
