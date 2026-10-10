import { css } from '../../styles/css';

const styles = css('ErrorText', {
  error: `
    margin: 6px 0 0;
    color: var(--warning);
    font-size: 12px;
    line-height: 1.4;
  `,
});

/** Renders nothing when there is nothing wrong, so callers need no conditional of their own. */
export function ErrorText({ children }: { children?: string | null }) {
  if (!children) return null;
  return <p className={styles.error} role="alert">{children}</p>;
}
