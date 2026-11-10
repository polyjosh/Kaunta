import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AdminApp } from './admin/AdminApp';
import { LoginScreen } from './counter/LoginScreen';
import { OrderDetailScreen } from './counter/OrderDetailScreen';
import { OrdersScreen } from './counter/OrdersScreen';
import { PairingGate } from './counter/PairScreen';
import { SellScreen } from './counter/SellScreen';
import { SessionProvider, useSession } from './counter/Session';
import { ShiftScreen } from './counter/ShiftScreen';
import { SyncScreen } from './counter/SyncScreen';
import { VoidScreen } from './counter/VoidScreen';
import './counter/counter.css';
import './counter/orders.css';
import { DbProvider } from './data/react';
import type { KauntaDB } from './data/db';
import { I18nProvider } from './lib/I18nProvider';
import { ThemeProvider } from './lib/ThemeProvider';
import { ComponentsGallery } from './routes/ComponentsGallery';
import { serverConfig } from './sync/config';
import type { ServerConfig } from './sync/config';
import { SyncProvider } from './sync/SyncProvider';
import type { SyncTransport } from './sync/transport';

/** Counter screens behind the PIN: without a session, back to the names. */
function RequireLogin() {
  const { person } = useSession();
  return person ? <Outlet /> : <Navigate to="/counter/login" replace />;
}

interface AppProps {
  db?: KauntaDB;
  /** The Supabase project. Defaults to `.env.local`; `null` runs on sample data only (demo). */
  config?: ServerConfig | null;
  /** For tests: talk to this instead of Supabase. */
  transport?: SyncTransport;
}

/**
 * All seven counter screens, syncing with Supabase when it is configured,
 * and the admin screens under /admin/* (their own store; see AdminApp).
 */
export function App({ db, config = serverConfig(), transport }: AppProps) {
  const demo = !config && !transport;
  return (
    <I18nProvider>
      <ThemeProvider>
        <DbProvider db={db} demo={demo}>
          <SyncProvider config={config} transport={transport}>
            <Routes>
              <Route path="/dev/components" element={<ComponentsGallery />} />
              <Route path="/admin/dev/components" element={<ComponentsGallery />} />
              <Route path="/admin/*" element={<AdminApp config={config} />} />
              <Route
                path="*"
                element={
                  <PairingGate enabled={!demo}>
                    <SessionProvider>
                      <Routes>
                        <Route path="/counter/login" element={<LoginScreen />} />
                        <Route path="/counter/sync" element={<SyncScreen />} />
                        <Route element={<RequireLogin />}>
                          <Route path="/counter/sell" element={<SellScreen />} />
                          <Route path="/counter/orders" element={<OrdersScreen />} />
                          <Route path="/counter/orders/:id" element={<OrderDetailScreen />} />
                          <Route path="/counter/orders/:id/void" element={<VoidScreen />} />
                          <Route path="/counter/shift/close" element={<ShiftScreen />} />
                          <Route path="/counter/*" element={<Navigate to="/counter/sell" replace />} />
                        </Route>
                        <Route path="*" element={<Navigate to="/counter/login" replace />} />
                      </Routes>
                    </SessionProvider>
                  </PairingGate>
                }
              />
            </Routes>
          </SyncProvider>
        </DbProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
