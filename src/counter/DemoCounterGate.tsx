import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { counterBar, DEMO_SAMPLE_BAR, demoBarByCode, demoStore, ensureMemberPeople, rememberCounterBar, seedNewDemoBar } from '../admin/bars';
import type { BarSummary } from '../admin/bars';
import { db as sampleCounterDb } from '../data/db';
import type { KauntaDB } from '../data/db';
import { DbProvider } from '../data/react';
import { useDemoServer } from '../data/demoServer';
import { seedDatabase } from '../data/seedDb';
import { formatBarCode, SAMPLE_BAR_CODE } from '../domain/barCode';
import { useI18n } from '../lib/I18nProvider';
import { Logo } from '../components/Icon';
import { isBarSuspended, usePlatform } from '../platform/platform';
import { BarCodeScreen } from './BarCodeScreen';

interface CounterBarValue {
  bar: BarSummary;
  /** Forget this bar on this browser and ask for a code again. */
  changeBar: () => void;
}

const CounterBarContext = createContext<CounterBarValue | null>(null);

/** In the demo, the bar this counter is for; null with a server (a phone stays with its bar). */
export function useCounterBar(): CounterBarValue | null {
  return useContext(CounterBarContext);
}

/**
 * Demo counter (no server): "Open the counter" asks for a bar code once, then
 * opens that bar's store in this browser. The sample bar opens the counter's
 * sample (22:20); a bar the owner added opens the store admin uses too.
 */
export function DemoCounterGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [bar, setBar] = useState<BarSummary | null>(counterBar);
  const changeBar = useCallback(() => {
    rememberCounterBar(null);
    setBar(null);
  }, []);
  // Admin's "Sell at the counter" may have pointed this browser at another bar meanwhile.
  const wanted = counterBar();
  if (wanted && wanted.id !== bar?.id) setBar(wanted);
  const value = useMemo(() => (bar ? { bar, changeBar } : null), [bar, changeBar]);
  const store: KauntaDB | null = bar ? (bar.id === DEMO_SAMPLE_BAR ? sampleCounterDb : demoStore(bar.id)) : null;
  // Either way the bar's owner and managers are on the list, with their current password or PIN.
  const seed = useMemo(
    () =>
      bar && bar.id !== DEMO_SAMPLE_BAR
        ? (d: KauntaDB) => seedNewDemoBar(d, bar)
        : async (d: KauntaDB) => {
            const created = await seedDatabase(d);
            await ensureMemberPeople(d, DEMO_SAMPLE_BAR);
            return created;
          },
    [bar],
  );
  // A bar the owner added: no server, so this browser accepts what the counter queues (admin sees it at once).
  useDemoServer(store, !!bar && bar.id !== DEMO_SAMPLE_BAR);
  // Kaunta suspended the bar: nobody signs in (and whoever was in is out) until access is given back.
  const p = usePlatform();
  if (bar && isBarSuspended(bar.id, p)) return <SuspendedBar name={bar.name} onChangeBar={changeBar} />;

  if (!bar || !store || !value) {
    return (
      <BarCodeScreen
        onSubmit={async (code) => {
          const found = demoBarByCode(code);
          if (!found) return 'bar.invalid';
          rememberCounterBar(found.id);
          setBar(found);
          return null;
        }}
        hint={t('bar.demoHint', { code: formatBarCode(SAMPLE_BAR_CODE) })}
      />
    );
  }
  return (
    <DbProvider key={bar.id} db={store} demo seed={seed}>
      <CounterBarContext.Provider value={value}>{children}</CounterBarContext.Provider>
    </DbProvider>
  );
}

/** The counter of a bar Kaunta suspended. */
function SuspendedBar({ name, onChangeBar }: { name: string; onChangeBar: () => void }) {
  const { t } = useI18n();
  return (
    <div className="c-screen">
      <header className="c-topbar">
        <Logo />
        <div className="c-topbar-id">
          <strong>{name}</strong>
        </div>
      </header>
      <main className="c-body c-barcode">
        <div className="c-barcode-form" role="alert">
          <div className="c-barcode-intro">
            <h1>{t('bar.suspendedTitle')}</h1>
            <p>{t('bar.suspendedBody', { bar: name })}</p>
          </div>
          <button type="button" className="c-btn c-btn-link" onClick={onChangeBar}>{t('bar.change')}</button>
        </div>
      </main>
    </div>
  );
}
