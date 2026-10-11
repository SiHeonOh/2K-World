import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { t } from '../i18n'
import { errorText, Notice } from './ui'

interface Props {
  children: ReactNode
  /** A change (the current route) clears the error, so leaving a broken screen works. */
  resetKey?: string
}

interface State {
  failed: boolean
  error: unknown
}

/** Catches a crash while drawing a screen, so the app shows the error instead of going blank. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, error }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack)
  }

  override componentDidUpdate(prev: Props) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.reset()
  }

  reset = () => this.setState({ failed: false, error: null })

  goHome = () => {
    // On the home screen already: nothing will change the key, so just try again.
    if (window.location.hash === '#/' || window.location.hash === '') this.reset()
    else window.location.hash = '#/'
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="page">
        <Notice tone="err">
          <div className="stack" style={{ gap: 8 }}>
            <span>
              <b>{t.errors.title}</b> · {errorText(this.state.error)}
            </span>
            <div className="row">
              <button className="btn small" onClick={this.reset}>
                {t.app.retry}
              </button>
              <button className="btn small ghost" onClick={this.goHome}>
                {t.errors.goHome}
              </button>
              <button className="btn small ghost" onClick={() => window.location.reload()}>
                {t.errors.crash.reload}
              </button>
            </div>
          </div>
        </Notice>
      </div>
    )
  }
}

/** The root boundary: it resets when the route changes. Must sit inside the router. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
}

/**
 * The outermost boundary, around the router too: if even the app's frame
 * fails to draw, a plain Korean screen with 다시 불러오기 instead of a
 * blank window. It leans on nothing that could have been what broke.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false, error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, error }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[app] the page failed to draw', error, info.componentStack)
  }

  override render() {
    if (!this.state.failed) return this.props.children
    const { error } = this.state
    return (
      <div className="app-crash" role="alert">
        <h1>{t.errors.crash.title}</h1>
        <p>{t.errors.crash.help}</p>
        <pre className="raw-error">{error instanceof Error ? error.message : String(error)}</pre>
        <button className="btn primary" onClick={() => window.location.reload()}>
          {t.errors.crash.reload}
        </button>
      </div>
    )
  }
}
