import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';
import { Icon } from './Icon';

interface Props {
  children: ReactNode;
  /** Changing it (the route) clears the error, so leaving the screen recovers. */
  resetKey: string;
  fallback: (error: Error) => ReactNode;
}

class Boundary extends Component<Props, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Kaunta] screen failed', error, info.componentStack);
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

/**
 * A screen that fails shows what went wrong and a way back, instead of a
 * blank page. Everything recorded is in the local store already.
 */
export function ScreenErrorBoundary({ children, home, back = 'error.back' }: { children: ReactNode; home: string; back?: MessageKey }) {
  const location = useLocation();
  return (
    <Boundary resetKey={location.pathname} fallback={(error) => <ErrorScreen error={error} home={home} back={back} />}>
      {children}
    </Boundary>
  );
}

function ErrorScreen({ error, home, back }: { error: Error; home: string; back: MessageKey }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <div className="c-screen k-error-screen" role="alert">
      <main className="c-body c-locked">
        <div className="c-locked-card">
          <span className="c-locked-icon">
            <Icon name="alert-triangle" size={34} />
          </span>
          <p className="c-locked-body">
            <strong>{t('error.title')}</strong>
          </p>
          <p className="c-locked-body">{t('error.body')}</p>
          <code className="k-error-text">{error.message}</code>
        </div>
        <div className="c-locked-actions">
          <button type="button" className="c-btn c-btn-primary" onClick={() => navigate(home, { replace: true })}>
            {t(back)}
          </button>
          <button type="button" className="c-btn c-btn-secondary" onClick={() => window.location.reload()}>
            {t('error.reload')}
          </button>
        </div>
      </main>
    </div>
  );
}
