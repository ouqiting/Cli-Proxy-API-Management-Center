import { useEffect, useRef } from 'react';
import { useWebdavStore } from '../store/useWebdavStore';
import { useBackupActions } from './useBackupActions';
import { AUTO_BACKUP_INTERVALS } from '../constants';

export function useAutoBackup() {
  const { autoBackup } = useBackupActions();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const autoBackupEnabled = useWebdavStore((s) => s.autoBackupEnabled);
  const autoBackupInterval = useWebdavStore((s) => s.autoBackupInterval);
  const hasHydrated = useWebdavStore((s) => s.hasHydrated);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (!hasHydrated || !autoBackupEnabled) return;

    const intervalConfig = AUTO_BACKUP_INTERVALS.find((i) => i.value === autoBackupInterval);
    if (!intervalConfig) return;
    const intervalMs = intervalConfig.ms;
    const WEBDAV_INTERVAL_MS = 24 * 60 * 60 * 1000; // Fixed at "Every day" (每天)

    const checkBackup = () => {
      const state = useWebdavStore.getState();
      if (state.isBackingUp || state.isRestoring) return;

      const now = Date.now();
      const lastTime = state.lastBackupTime ? new Date(state.lastBackupTime).getTime() : 0;
      const lastWebdavTime = state.lastWebdavBackupTime ? new Date(state.lastWebdavBackupTime).getTime() : 0;
      
      const webdavElapsed = now - lastWebdavTime;
      const localElapsed = now - lastTime;
      
      if (webdavElapsed >= WEBDAV_INTERVAL_MS) {
        autoBackup({ localOnly: false });
      } else if (localElapsed >= intervalMs) {
        autoBackup({ localOnly: true });
      }
    };

    // Run check immediately
    checkBackup();

    // Re-check every minute
    timerRef.current = setInterval(checkBackup, 60 * 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [autoBackupEnabled, autoBackupInterval, hasHydrated, autoBackup]);
}

