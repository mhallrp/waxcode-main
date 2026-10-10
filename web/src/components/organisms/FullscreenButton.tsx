import { useEffect, useState } from 'react';
import { css } from '../../styles/css';

const styles = css('FullscreenButton', {
  button: `
    /** Dimmed, unlike record and settings: this is a convenience rather than a primary control */
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    padding: 10px;
    border: 0;
    background: transparent;
    color: var(--ink-dim);
  `,
});

/** Offered only where the browser actually supports it. */
export function FullscreenButton() {
  const [full, setFull] = useState(false);
  const supported = typeof document !== 'undefined' && document.fullscreenEnabled;

  useEffect(() => {
    const onChange = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  if (!supported) return null;

  return (
    <button
      type="button"
      className={styles.button}
      aria-label={full ? 'Leave full screen' : 'Full screen'}
      onClick={() => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => {});
      }}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        {full
          ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
          : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
      </svg>
    </button>
  );
}
