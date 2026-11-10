import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { seedAdminDatabase } from '../data/adminSeed';
import { KauntaDB } from '../data/db';
import { DbProvider } from '../data/react';
import { businessDayOf } from '../domain/time';
import type { MessageKey } from '../lib/i18n';
import { serverConfig } from '../sync/config';
import type { ServerConfig } from '../sync/config';
import { AdminSignIn } from './AdminSignIn';
import { AdminServer, AdminSync, applyAdminPull } from './server';
import { AdminSessionProvider, useAdmin } from './AdminSession';
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

let demoDb: KauntaDB | null = null;
/** The admin demo has its own store (the full sample day), apart from the counter's. */
function adminDemoDb(): KauntaDB {
  demoDb ??= new KauntaDB('kaunta-admin-demo');
  return demoDb;
}

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
  if (server || config) return <AdminLive server={server ?? new AdminServer(config!)} db={db} />;
  return <AdminDemo db={db} />;
}

type LiveState = 'signedOut' | 'loading' | 'ready';

/**
 * With a server: sign in, fill the admin store from admin_pull, then keep it
 * in step (AdminSync). The store is this browser's copy for this account and
 * is wiped on sign-out.
 */
function AdminLive({ server: given, db }: { server: AdminServer; db?: KauntaDB }) {
  const [server] = useState(given);
  const [store, setStore] = useState(() => db ?? new KauntaDB('kaunta-admin'));
  const [state, setState] = useState<LiveState>(server.signedIn ? 'loading' : 'signedOut');
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const [me, setMe] = useState<string | null>(null);

  useEffect(() => {
    if (state !== 'loading') return;
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
        const data = await server.pull(null);
        await applyAdminPull(store, data);
        if (!cancelled) {
          setMe(data.me);
          setState('ready');
        }
      } catch (error) {
        if (cancelled) return;
        server.signOut();
        setNotice((error as Error).message === 'not_admin' ? 'admin.signIn.notAdmin' : 'admin.signIn.offline');
        setState('signedOut');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, server, store]);

  useEffect(() => {
    if (state !== 'ready') return;
    const sync = new AdminSync(store, server);
    sync.start();
    return () => sync.stop();
  }, [state, server, store]);

  const signOut = useCallback(() => {
    server.signOut();
    setMe(null);
    setNotice(null);
    setState('signedOut');
    void store.delete().then(() => setStore(new KauntaDB(store.name)));
  }, [server, store]);

  if (state === 'signedOut') return <AdminSignIn server={server} notice={notice} onSignedIn={() => setState('loading')} />;
  if (state === 'loading' || !me) return <div className="a-app" aria-busy="true" />;
  return (
    <DbProvider db={store} demo={false}>
      <AdminSessionProvider personId={me} signOut={signOut} createPairingCode={server.createPairingCode}>
        <AdminRoutes />
      </AdminSessionProvider>
    </DbProvider>
  );
}

function AdminDemo({ db }: { db?: KauntaDB }) {
  const [store] = useState(() => db ?? adminDemoDb());
  return (
    <DbProvider db={store} demo seed={seedAdminDatabase}>
      <AdminSessionProvider>
        <AdminRoutes />
      </AdminSessionProvider>
    </DbProvider>
  );
}
