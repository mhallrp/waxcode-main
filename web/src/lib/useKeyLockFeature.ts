import { api } from './api';
import { useBoxData } from './useBoxData';
import type { KeyLockFeature } from '../types';

/** Whether the key lock experiment is switched on for this box. */
export function useKeyLockFeature(): boolean {
  const feature = useBoxData<KeyLockFeature>(api.keyLockFeature, { everyMs: 60_000 });
  return feature.data?.enabled === true;
}
