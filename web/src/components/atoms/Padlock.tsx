import { css } from '../../styles/css';

const styles = css('Padlock', {
  icon: `
    /** No margin: the button's own 8px gap is the spacing, and adding to it here made the pair sit 14px apart instead of 8. */
    fill: currentColor; display: block; width: 11px; height: 14px;
  `,
});

/** Open or closed, for the two lock toggles. Decorative - the button's text carries the meaning. */
export function Padlock({ locked }: { locked: boolean }) {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
      {locked
        ? <path d="M7 10V7a5 5 0 0110 0v3h1.5a1.5 1.5 0 011.5 1.5v9A1.5 1.5 0 0118.5 22h-13A1.5 1.5 0 014 20.5v-9A1.5 1.5 0 015.5 10H7zm2 0h6V7a3 3 0 00-6 0v3z" />
        : <path d="M7 10V7a5 5 0 019.9-1 1 1 0 11-2 .3A3 3 0 009 7v3h9.5a1.5 1.5 0 011.5 1.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 20.5v-9A1.5 1.5 0 015.5 10H7z" />}
    </svg>
  );
}
