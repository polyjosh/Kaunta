import { useId, useState } from 'react';
import { Icon } from '../components/Icon';
import { useQuery } from '../data/react';
import { BAR_CODE_MAX, formatBarCode, isChoosableBarCode, normaliseBarCode } from '../domain/barCode';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';
import { useAdmin } from './AdminSession';

/**
 * The open bar's counter code: what a new counter phone types once after
 * "Open the counter". The owner can change it to a code of their own (6–12
 * letters or digits, unique across all bars), or ask for a fresh one.
 */
export function BarCodeCard() {
  const { t } = useI18n();
  const id = useId();
  const { person, bars, barId, changeBarCode } = useAdmin();
  const row = useQuery(async (db) => (await db.bar.toCollection().first())?.counter_code ?? null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [wanted, setWanted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [done, setDone] = useState(false);
  // A bar's own row is the truth; the bar list covers the sample bar, whose admin store predates codes.
  const listed = bars.find((b) => b.id === barId)?.counter_code;
  const code = (barId && listed) || row || null;
  if (row === undefined || !code) return null;
  const owner = person.role === 'owner';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatBarCode(code));
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // No clipboard (an old browser or no permission): the code is on screen to read out.
    }
  };

  const apply = async (choice?: string) => {
    if (!changeBarCode) return;
    if (choice !== undefined && !isChoosableBarCode(choice)) return setError('admin.barCode.invalid');
    setBusy(true);
    setError(null);
    try {
      const result = await changeBarCode(choice);
      if ('error' in result) return setError(result.error === 'taken' ? 'admin.barCode.taken' : 'admin.barCode.invalid');
      setDone(true);
      setEditing(false);
      setWanted('');
    } catch {
      setError('admin.barCode.failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="a-card a-barcode" aria-labelledby="barcode-h">
      <h2 id="barcode-h">{t('admin.barCode.title')}</h2>
      <div className="a-barcode-row">
        <output className="a-pair-code a-barcode-code" aria-label={t('admin.barCode.title')}>{formatBarCode(code)}</output>
        <button type="button" className="a-btn a-btn-sm" onClick={copy}>
          <Icon name={copied ? 'check' : 'list'} size={16} /> {copied ? t('admin.barCode.copied') : t('admin.barCode.copy')}
        </button>
      </div>
      <p className="a-note">{t('admin.barCode.body')}</p>
      {done && <p className="a-ok" role="status"><Icon name="check" size={18} /> {t('admin.barCode.newDone')}</p>}

      {owner && changeBarCode ? (
        editing ? (
          <form className="a-barcode-confirm" onSubmit={(e) => { e.preventDefault(); void apply(wanted); }}>
            <label className="a-field a-field-sm" htmlFor={id}>{t('admin.barCode.yours')}</label>
            <input
              id={id}
              className="a-input a-barcode-input"
              type="text"
              value={wanted}
              autoFocus
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('admin.barCode.placeholder')}
              aria-invalid={error ? true : undefined}
              onChange={(e) => { setError(null); setWanted(formatBarCode(normaliseBarCode(e.target.value).slice(0, BAR_CODE_MAX))); }}
            />
            <p className="a-note">{t('admin.barCode.rules')}</p>
            <p className="a-note is-strong">{t('admin.barCode.newConfirm')}</p>
            {error && <p className="a-error" role="alert">{t(error)}</p>}
            <div className="a-actions">
              <button type="submit" className="a-btn a-btn-primary a-btn-sm" disabled={busy || !wanted}>{t('admin.barCode.save')}</button>
              <button type="button" className="a-btn a-btn-sm" disabled={busy} onClick={() => void apply()}>{t('admin.barCode.suggest')}</button>
              <button type="button" className="a-btn a-btn-sm" onClick={() => { setEditing(false); setError(null); }}>{t('common.cancel')}</button>
            </div>
          </form>
        ) : (
          <button type="button" className="a-text-btn" onClick={() => { setDone(false); setEditing(true); }}>{t('admin.barCode.change')}</button>
        )
      ) : (
        <p className="a-note">{t('admin.barCode.ownerOnly')}</p>
      )}
    </section>
  );
}
