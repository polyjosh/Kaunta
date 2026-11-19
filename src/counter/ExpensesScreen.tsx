import { useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useDb, useQuery } from '../data/react';
import { addExpense, openShiftOf, removeExpense } from '../data/shifts';
import { EXPENSE_LABEL_MAX, expensesTotal, paidFromTill, tillExpensesTotal } from '../domain/shifts';
import type { ExpenseSource } from '../domain/types';
import { localTime } from '../domain/time';
import { useI18n } from '../lib/I18nProvider';
import { formatAmount, formatKES } from '../lib/money';
import { useSession } from './Session';
import { BackBar } from './ui';

const SOURCES: readonly ExpenseSource[] = ['cash', 'mpesa'];

/**
 * Expenses this shift: what was paid for, how much, and whether it came out
 * of the cash drawer (taken off the cash expected at close) or was paid from
 * the bar's M-Pesa till (taken off what the till statement should show).
 */
export function ExpensesScreen() {
  const { t } = useI18n();
  const db = useDb();
  const session = useSession();
  const me = session.person;
  const deviceId = session.device?.id;
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [source, setSource] = useState<ExpenseSource | null>(null);
  const [problem, setProblem] = useState<'label' | 'amount' | 'source' | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const busy = useRef(false);
  const labelRef = useRef<HTMLInputElement>(null);

  const data = useQuery(
    async (d) => {
      const shift = me && deviceId ? ((await openShiftOf(d, me.id, deviceId)) ?? null) : null;
      if (!shift) return null;
      const approvals = await d.approvals.filter((a) => a.kind === 'expense' && a.target.shift_id === shift.id).toArray();
      return { shift, status: new Map(approvals.map((a) => [a.target.expense_id!, a.status])) };
    },
    [me?.id, deviceId],
  );
  if (!me || data === undefined) return null;
  if (data === null) {
    return (
      <div className="c-screen">
        <BackBar to="/counter/sell" title={t('expense.title')} />
      </div>
    );
  }

  const { shift, status } = data;
  const rejected = new Set([...status].filter(([, s]) => s === 'rejected').map(([id]) => id));
  const kes = amount === '' ? 0 : Number(amount);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    const wrong = !label.trim() ? 'label' : !(kes > 0) ? 'amount' : !source ? 'source' : null;
    setProblem(wrong);
    if (wrong || !source) return;
    busy.current = true;
    try {
      await addExpense(db, session.recordContext(), { label, amount_kes: kes, paid_from: source });
      setAdded(t('expense.added', { label: label.trim(), amount: formatKES(kes) }));
      setLabel('');
      setAmount('');
      setSource(null);
      labelRef.current?.focus();
    } finally {
      busy.current = false;
    }
  };

  const expenses = [...shift.expenses].reverse();
  return (
    <div className="c-screen">
      <BackBar to="/counter/sell" title={t('expense.title')} subtitle={`${me.name} · ${localTime(shift.opened_at)}`} />
      <main className="c-body c-shift c-expenses">
        <form className="c-expense-form" onSubmit={(e) => void add(e)} noValidate>
          <label className="c-field">
            <span className="c-field-label">{t('expense.what')}</span>
            <input
              ref={labelRef}
              className="c-text-input"
              value={label}
              maxLength={EXPENSE_LABEL_MAX}
              placeholder={t('expense.whatHint')}
              aria-invalid={problem === 'label'}
              onChange={(e) => {
                setLabel(e.target.value);
                setAdded(null);
              }}
            />
          </label>
          <div className="c-field">
            <label className="c-field-label" htmlFor="expense-amount">
              {t('expense.amount')}
            </label>
            <span className="c-money-input">
              <span aria-hidden="true">KES</span>
              <input
                id="expense-amount"
                className="c-text-input"
                inputMode="numeric"
                value={amount === '' ? '' : formatAmount(kes)}
                aria-invalid={problem === 'amount'}
                onChange={(e) => {
                  setAmount(e.target.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 7));
                  setAdded(null);
                }}
              />
            </span>
          </div>
          <div className="c-field">
            <span className="c-field-label" id="expense-from">
              {t('expense.from')}
            </span>
            <div className="c-choice-grid c-choice-2" role="radiogroup" aria-labelledby="expense-from">
              {SOURCES.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={source === s} className="c-choice c-choice-method" onClick={() => setSource(s)}>
                  {t(s === 'cash' ? 'expense.fromCash' : 'expense.fromTill')}
                </button>
              ))}
            </div>
            <span className="c-field-hint">{t(source === 'mpesa' ? 'expense.tillHint' : 'expense.cashHint')}</span>
          </div>
          {problem && (
            <p className="c-form-error" role="alert">
              {t(`expense.error.${problem}`)}
            </p>
          )}
          {added && !problem && (
            <p className="c-form-ok" role="status">
              <Icon name="check" size={18} /> {added}
            </p>
          )}
          <button type="submit" className="c-btn c-btn-primary">
            {t('expense.add')}
          </button>
        </form>

        <section aria-labelledby="expense-list">
          <h2 className="c-section-title" id="expense-list">
            {t('expense.list')}
          </h2>
          <p className="c-field-hint">{t('expense.approvalNote')}</p>
          {expenses.length === 0 && <p className="c-field-hint">{t('expense.none')}</p>}
          <ul className="c-expense-list">
            {expenses.map((e, i) => {
              const state = e.id ? status.get(e.id) : undefined;
              return (
              <li key={e.id ?? i} className={`c-expense-row${state === 'rejected' ? ' is-rejected' : ''}`}>
                <div className="c-expense-text">
                  <strong>{e.label}</strong>
                  <span>
                    {t(paidFromTill(e) ? 'expense.fromTill' : 'expense.fromCash')}
                    {e.at ? ` · ${localTime(e.at)}` : ''}
                  </span>
                  {(state === 'waiting' || state === 'approved' || state === 'rejected') && (
                    <span className={`c-expense-status is-${state}`}>{t(`expense.status.${state}`)}</span>
                  )}
                </div>
                <strong className="c-expense-amount">{formatKES(e.amount_kes)}</strong>
                {e.id && (state === undefined || state === 'waiting') && (
                  <button
                    type="button"
                    className="c-icon-btn"
                    aria-label={t('expense.remove', { label: e.label })}
                    onClick={() => void removeExpense(db, session.recordContext(), e.id!)}
                  >
                    <Icon name="close" size={20} />
                  </button>
                )}
              </li>
              );
            })}
          </ul>
          <dl className="c-breakdown">
            <div>
              <dt>{t('expense.totalCash')}</dt>
              <dd>{formatKES(expensesTotal(shift, rejected))}</dd>
            </div>
            <div>
              <dt>{t('expense.totalTill')}</dt>
              <dd>{formatKES(tillExpensesTotal(shift, rejected))}</dd>
            </div>
          </dl>
        </section>
      </main>
    </div>
  );
}
