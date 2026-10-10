import { useCallback, useState } from 'react';
import { ConfirmDialog, type ConfirmOptions } from '../components/organisms/ConfirmDialog';

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

/** `const [confirm, dialog] = useConfirm` — await confirm({...}), render {dialog}. */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, React.ReactNode] {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );

  const dialog = pending ? (
    <ConfirmDialog
      {...pending}
      onResolve={(ok) => {
        pending.resolve(ok);
        setPending(null);
      }}
    />
  ) : null;

  return [confirm, dialog];
}
