import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon, Lockup } from '../components/Icon';
import { useI18n } from '../lib/I18nProvider';
import { isStandalone, lastWay, rememberWay, useInstall } from '../lib/install';
import './landing.css';

/**
 * `/`: the logo and its promise, then the two ways in. "Open the counter"
 * asks once for the bar's code (that decides the bar), then staff log in with
 * their PIN; owners and managers sign in and pick a bar. The installed app
 * starts here too, and goes straight to the way this device used last, so a
 * counter phone opens on its counter.
 */
export function Landing() {
  const { t, locale, setLocale } = useI18n();
  const navigate = useNavigate();
  const install = useInstall();

  useEffect(() => {
    const way = lastWay();
    if (way && isStandalone()) navigate(way, { replace: true });
  }, [navigate]);

  return (
    <div className="l-page">
      <main className="l-main">
        <div className="l-hero">
          <h1 className="l-logo">
            <Lockup kind="stacked" scheme="dark" height={200} />
          </h1>
          <p className="l-promise">{t('landing.promise')}</p>
        </div>

        <nav className="l-ways" aria-label={t('landing.ways')}>
          <Link className="l-way is-counter" to="/counter/login" onClick={() => rememberWay('/counter/login')}>
            <span className="l-way-icon" aria-hidden="true"><Icon name="receipt" size={26} /></span>
            <span className="l-way-text">
              <strong>{t('landing.counter')}</strong>
              <span>{t('landing.counterHint')}</span>
            </span>
          </Link>
          <Link className="l-way" to="/admin" onClick={() => rememberWay('/admin')}>
            <span className="l-way-icon" aria-hidden="true"><Icon name="pie" size={26} /></span>
            <span className="l-way-text">
              <strong>{t('landing.admin')}</strong>
              <span>{t('landing.adminHint')}</span>
            </span>
          </Link>
        </nav>

        {install.canInstall && (
          <button type="button" className="l-install" onClick={() => void install.install()}>
            <Icon name="cloud-check" size={22} />
            <span>
              <strong>{t('landing.install')}</strong>
              <span>{t('landing.installHint')}</span>
            </span>
          </button>
        )}
        {install.iosHint && <p className="l-install-note">{t('landing.installIos')}</p>}

        <div className="l-lang" role="group" aria-label={t('landing.language')}>
          <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>English</button>
          <button type="button" aria-pressed={locale === 'sw'} onClick={() => setLocale('sw')}>Kiswahili</button>
        </div>
      </main>
      <footer className="l-foot">
        <p>{t('landing.notPayments')}</p>
        <Link className="l-platform" to="/super">{t('super.landing')}</Link>
      </footer>
    </div>
  );
}
