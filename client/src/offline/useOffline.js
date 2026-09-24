import { useSyncExternalStore } from 'react';
import { subscribe, getOfflineState } from './index.js';

// The offline state for a screen: { online, snapshotAt, queue, syncing, lastSync, snapshotError, needsSignIn, others }.
export function useOffline() {
  return useSyncExternalStore(subscribe, getOfflineState, getOfflineState);
}

// true while the internet is reachable (buttons that need it read this).
export function useOnline() {
  return useOffline().online;
}
