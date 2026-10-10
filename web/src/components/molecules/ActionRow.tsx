import { Button } from '../atoms/Button';
import { css } from '../../styles/css';

const styles = css('ActionRow', {
  chevron: `
    color: var(--ink-faint); font-size: 17px;
  `,
});

interface Props {
  label: string;
  /** Absent on a row that is only ever disabled - the update row, which says why it cannot run. */
  onPress?: () => void;
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
}

/** A full-width row that does something. The chevron is decorative, hence aria-hidden. */
export function ActionRow({ label, onPress, busy, busyLabel, disabled }: Props) {
  return (
    <Button variant="row" onClick={onPress} busy={busy} busyLabel={busyLabel} disabled={disabled}>
      <span>{label}</span>
      <span className={styles.chevron} aria-hidden="true">&rsaquo;</span>
    </Button>
  );
}
