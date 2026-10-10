import { useEffect } from 'react';
import { KEYBOARD_INSET_VAR, keyboardInset } from './keyboardInset';

/** Keeps the view still when the keyboard opens, and tells the layout how much it covers. */
export function useKeyboardInset() {
  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;

    const root = document.documentElement;

    const apply = () => {
      root.style.setProperty(KEYBOARD_INSET_VAR, `${keyboardInset(window.innerHeight, visual)}px`);

      /** The actual fix for "the entire view moves up". */
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    };

    apply();
    visual.addEventListener('resize', apply);
    visual.addEventListener('scroll', apply);
    /** Also on focus: the keyboard animates in, so the first resize can arrive before it has finished and report a smaller inset than the keyboard */
    window.addEventListener('focusin', apply);
    window.addEventListener('focusout', apply);

    return () => {
      visual.removeEventListener('resize', apply);
      visual.removeEventListener('scroll', apply);
      window.removeEventListener('focusin', apply);
      window.removeEventListener('focusout', apply);
      root.style.removeProperty(KEYBOARD_INSET_VAR);
    };
  }, []);
}
