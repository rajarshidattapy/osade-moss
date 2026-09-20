import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './tokens.css';

let wheelAcc = 0;
window.addEventListener(
  'wheel',
  (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (event.deltaY === 0) return;
    wheelAcc += event.deltaY;
    if (Math.abs(wheelAcc) < 40) return;
    const step: 1 | -1 = wheelAcc < 0 ? 1 : -1;
    wheelAcc = 0;
    void window.osade?.zoom(step);
  },
  { passive: false },
);

class CrashScreen extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  override render() {
    if (this.state.error) {
      return (
        <pre style={{ margin: 24, color: '#c9d1d9', background: '#0f1214', whiteSpace: 'pre-wrap' }}>{this.state.error}</pre>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>,
);
