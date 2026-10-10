import { css } from '../../styles/css';

const styles = css('Icon', {
  icon: `
    display: block;
  `,
});

type Name = 'folder' | 'drive' | 'star' | 'search' | 'plus';

const PATHS: Record<Name, string> = {
  folder: 'M3 6.5A1.5 1.5 0 014.5 5h4l1.6 2h9.4A1.5 1.5 0 0121 8.5v9a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z',
  drive: 'M4 5.5A1.5 1.5 0 015.5 4h13A1.5 1.5 0 0120 5.5v13a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 18.5zm3 2.5v2h10V8z',
  star: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z',
  search: 'M11 4a7 7 0 105.2 11.7l3.5 3.6 1.4-1.4-3.6-3.5A7 7 0 0011 4zm0 2a5 5 0 110 10 5 5 0 010-10z',
  /** An ACTION, not a place. */
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
};

/** One shape, one name. Decorative - whatever it sits beside carries the meaning. */
export function Icon({ name, filled = true }: { name: Name; filled?: boolean }) {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
