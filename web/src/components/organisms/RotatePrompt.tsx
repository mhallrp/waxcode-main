import { css } from '../../styles/css';

const styles = css('RotatePrompt', {
  prompt: `
    display: none;
    /** Written BELOW the base rule on purpose. */
    @media (orientation: portrait) {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 24px;
      background: var(--bg);
      color: var(--accent);
      text-align: center;
    }
    /** Written BELOW the base rule on purpose. */
    @media (orientation: portrait) {
      & b { color: var(--ink); font: 500 16px/1 var(--mono); }
    }
    /** Written BELOW the base rule on purpose. */
    @media (orientation: portrait) {
      & p { margin: 0; color: var(--ink-faint); font-size: 13px; }
    }
  `,
});

/** Shown in portrait only, by CSS. */
export function RotatePrompt() {
  return (
    <div className={styles.prompt}>
      <svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="7.5" width="18" height="11" rx="2" />
        <path d="M12 3.2a4.6 4.6 0 0 1 3.6 1.8" />
        <path d="M15.8 2.2v2.9h-2.9" />
      </svg>
      <b>Rotate to landscape</b>
      <p>If the screen won&rsquo;t turn, check Rotation Lock.</p>
    </div>
  );
}
