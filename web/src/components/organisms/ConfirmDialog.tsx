import { Button } from '../atoms/Button';
import { css } from '../../styles/css';

const styles = css('ConfirmDialog', {
  backdrop: `
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgb(0 0 0 / 55%);
    z-index: 50;
  `,
  panel: `
    width: min(420px, 100%);
    padding: 20px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    background: var(--surface);
  `,
  title: `
    display: block; font: 500 16px/1.3 var(--mono);
  `,
  message: `
    margin: 10px 0 18px; color: var(--ink-dim); font-size: 13px; line-height: 1.5;
  `,
  actions: `
    display: flex; justify-content: flex-end; gap: var(--gap-sm);
  `,
});

export interface ConfirmOptions {
  title: string;
  message: string;
  confirm: string;
  cancel?: string;
  /** Red confirm. Only for something that actually loses data - see useConfirm's note. */
  destructive?: boolean;
}

interface Props extends ConfirmOptions {
  onResolve: (ok: boolean) => void;
}

export function ConfirmDialog({ title, message, confirm, cancel = 'Cancel', destructive, onResolve }: Props) {
  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.panel}>
        <b className={styles.title}>{title}</b>
        <p className={styles.message}>{message}</p>
        <div className={styles.actions}>
          <Button onClick={() => onResolve(false)}>{cancel}</Button>
          <Button variant={destructive ? 'danger' : 'plain'} onClick={() => onResolve(true)}>
            {confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}
