import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDb } from '../data/react';
import { loadReceipt } from '../data/receipt';
import type { ReceiptData } from '../data/receipt';
import type { Id, Instant } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import { formatAmount, formatKES } from '../lib/money';
import { displayLabel, productName, sizeLabel } from './labels';
import './receipt.css';

const PRINT_KEY = 'kaunta.printReceipts';

/** Whether this phone prints a receipt by itself after each sale (on unless turned off here). */
export function printsReceipts(): boolean {
  try {
    return localStorage.getItem(PRINT_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setPrintsReceipts(on: boolean): void {
  try {
    localStorage.setItem(PRINT_KEY, on ? 'on' : 'off');
  } catch {
    // Only a convenience: printing stays on.
  }
}

export type PaperWidth = 80 | 58;
const PAPER_KEY = 'kaunta.paperWidth';
/** What a roll printer can print on: 72 mm of 80 mm paper, 48 mm of 58 mm. */
const PRINTABLE_MM: Record<PaperWidth, number> = { 80: 72, 58: 48 };
/** Paper fed after the last line, so a cutter does not cut through it. */
const TAIL_MM = 4;

/** The roll this phone's printer takes (80 mm unless set to 58 mm here). */
export function paperWidth(): PaperWidth {
  try {
    return localStorage.getItem(PAPER_KEY) === '58' ? 58 : 80;
  } catch {
    return 80;
  }
}

export function setPaperWidth(width: PaperWidth): void {
  try {
    localStorage.setItem(PAPER_KEY, String(width));
  } catch {
    // Only a convenience: 80 mm stays.
  }
}

/**
 * The page for one receipt: as wide as the roll, and exactly as long as the
 * receipt, so a roll printer feeds to the last line and stops (and cuts),
 * like a supermarket till: short receipts stay short, long ones are never split.
 */
export function receiptPageCss(width: PaperWidth, heightPx: number): string {
  const heightMm = Math.ceil((heightPx * 25.4) / 96) + TAIL_MM;
  return `@page { size: ${width}mm ${Math.max(heightMm, 30)}mm; margin: 0; }`;
}

const PAGE_STYLE_ID = 'k-receipt-page';

/** Measures the receipt at the roll's width and sets the page to its length. */
function fitPageToReceipt(width: PaperWidth): void {
  const root = document.querySelector<HTMLElement>('.k-receipt-root');
  const receipt = root?.querySelector<HTMLElement>('.k-receipt');
  if (!root || !receipt) return;
  root.style.setProperty('--k-paper', `${width}mm`);
  root.style.setProperty('--k-printable', `${PRINTABLE_MM[width]}mm`);
  root.classList.add('is-measuring');
  const height = receipt.getBoundingClientRect().height;
  root.classList.remove('is-measuring');
  let style = document.getElementById(PAGE_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = PAGE_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = `@media print { ${receiptPageCss(width, height)} }`;
}

interface ReceiptPrinter {
  /** Prints this order's receipt now (the phone's print dialog). */
  print: (orderId: Id) => Promise<void>;
  /** After a sale: prints only if this phone prints receipts. */
  printAfterSale: (orderId: Id) => Promise<void>;
}

const noop = async () => undefined;
const ReceiptContext = createContext<ReceiptPrinter>({ print: noop, printAfterSale: noop });

export function usePrintReceipt(): ReceiptPrinter {
  return useContext(ReceiptContext);
}

/**
 * Prints receipts with the browser's own print (any printer the phone can
 * print to: a receipt printer through its print service, Wi-Fi, PDF). The
 * receipt is drawn outside the app; while printing, only it is on the page.
 */
export function ReceiptProvider({ children }: { children: ReactNode }) {
  const db = useDb();
  const [receipt, setReceipt] = useState<{ data: ReceiptData; printedAt: Date; key: number } | null>(null);

  const print = useCallback(
    async (orderId: Id) => {
      const data = await loadReceipt(db, orderId);
      if (data) setReceipt((r) => ({ data, printedAt: new Date(), key: (r?.key ?? 0) + 1 }));
    },
    [db],
  );
  const printAfterSale = useCallback(async (orderId: Id) => {
    if (printsReceipts()) await print(orderId);
  }, [print]);

  // Once the receipt is on the page, open the print dialog.
  useEffect(() => {
    if (!receipt) return;
    document.body.classList.add('k-printing');
    const done = () => document.body.classList.remove('k-printing');
    window.addEventListener('afterprint', done, { once: true });
    const frame = requestAnimationFrame(() => {
      try {
        fitPageToReceipt(paperWidth());
        window.print();
      } catch {
        // No print here (some in-app browsers): the sale is recorded either way.
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('afterprint', done);
    };
  }, [receipt]);

  return (
    <ReceiptContext.Provider value={{ print, printAfterSale }}>
      {children}
      {receipt && createPortal(<Receipt key={receipt.key} data={receipt.data} printedAt={receipt.printedAt} />, document.body)}
    </ReceiptContext.Provider>
  );
}

/** "23 Nov 2026 22:08", in Nairobi time like the rest of the counter. */
export function receiptTime(instant: Instant | Date, locale: string): string {
  const shifted = new Date(new Date(instant).getTime() + 3 * 60 * 60 * 1000);
  const day = new Intl.DateTimeFormat(locale === 'sw' ? 'sw-KE' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(shifted);
  return `${day} ${shifted.toISOString().slice(11, 16)}`;
}

export function Receipt({ data, printedAt }: { data: ReceiptData; printedAt: Date }) {
  const { t, locale } = useI18n();
  const method = (m: 'cash' | 'mpesa') => (m === 'cash' ? t('pay.cash') : t('pay.mpesa'));
  return (
    <div className="k-receipt-root" aria-hidden="true">
      <article className="k-receipt" data-testid="receipt">
        <header className="k-receipt-head">
          <strong className="k-receipt-bar">{data.bar_name}</strong>
          <span>{t('receipt.title')}</span>
        </header>

        <dl className="k-receipt-meta">
          <div><dt>{t('receipt.order')}</dt><dd>{data.short_no} · {displayLabel(data.label, t)}</dd></div>
          {data.note && <div><dt>{t('receipt.note')}</dt><dd>{data.note}</dd></div>}
          <div><dt>{t('receipt.date')}</dt><dd>{receiptTime(data.created_at, locale)}</dd></div>
          <div><dt>{t('receipt.server')}</dt><dd>{data.server}</dd></div>
          <div><dt>{t('receipt.recordedBy')}</dt><dd>{data.recorded_by}{data.device ? ` · ${data.device}` : ''}</dd></div>
        </dl>

        <table className="k-receipt-lines">
          <thead>
            <tr><th>{t('receipt.item')}</th><th>{t('receipt.amount')}</th></tr>
          </thead>
          <tbody>
            {data.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  {l.product ? productName(l.product, locale) : ''} {l.size ? sizeLabel(l.size, locale) : ''}
                  <small>
                    {l.qty} × {formatAmount(l.unit_price_kes)}
                    {l.void_pending ? ` · ${t('receipt.voidPending')}` : ''}
                  </small>
                </td>
                <td>{formatAmount(l.total_kes)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="k-receipt-totals">
          <div className="is-total"><dt>{t('receipt.total')}</dt><dd>{formatKES(data.total_kes)}</dd></div>
          {data.payments.map((p, i) => (
            <div key={i}>
              <dt>{method(p.method)}{p.mpesa_ref_last4 ? ` ···${p.mpesa_ref_last4}` : ''}</dt>
              <dd>{formatKES(p.amount_kes)}</dd>
            </div>
          ))}
          {data.voided ? (
            <div className="is-status"><dt>{t('receipt.voided')}</dt><dd /></div>
          ) : data.due_kes > 0 ? (
            <div className="is-status"><dt>{data.paid_kes > 0 ? t('receipt.balance') : t('receipt.payLater')}</dt><dd>{formatKES(data.due_kes)}</dd></div>
          ) : (
            <div className="is-status"><dt>{t('receipt.paid')}</dt><dd /></div>
          )}
        </dl>

        <footer className="k-receipt-foot">
          <span>{t('receipt.thanks')}</span>
          <span>{t('receipt.printed', { time: receiptTime(printedAt, locale) })} · Kaunta Book</span>
        </footer>
      </article>
    </div>
  );
}
