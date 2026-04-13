import { useEffect, useState, type ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { restoreLatestLocalBackupIfNeeded } from '@/features/webdavBackup/hooks/useBackupActions';

let restoredBackupScopeKey = '';
let restoringBackupScopeKey = '';
let restoreLatestBackupPromise: Promise<void> | null = null;

export function ProtectedRoute({ children }: { children: ReactElement }) {
  const location = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const managementKey = useAuthStore((state) => state.managementKey);
  const apiBase = useAuthStore((state) => state.apiBase);
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      const shouldCheckAuth = !isAuthenticated && Boolean(managementKey) && Boolean(apiBase);
      const shouldRestore = isAuthenticated && Boolean(managementKey) && Boolean(apiBase);

      if (!shouldCheckAuth && !shouldRestore) {
        if (!cancelled) {
          setChecking(false);
        }
        return;
      }

      setChecking(true);
      try {
        if (shouldCheckAuth) {
          await checkAuth();
        }

        const authState = useAuthStore.getState();
        const latestScopeKey = `${authState.apiBase ?? ''}::${authState.managementKey ?? ''}`;
        const canRestore =
          authState.isAuthenticated &&
          Boolean(authState.apiBase) &&
          Boolean(authState.managementKey) &&
          latestScopeKey !== restoredBackupScopeKey;

        if (!canRestore) {
          return;
        }

        if (!restoreLatestBackupPromise || restoringBackupScopeKey !== latestScopeKey) {
          restoringBackupScopeKey = latestScopeKey;
          restoreLatestBackupPromise = restoreLatestLocalBackupIfNeeded()
            .then(() => undefined)
            .catch((error) => {
              console.warn('[Backup] Auto-restore latest local backup failed:', error);
            })
            .finally(() => {
              restoredBackupScopeKey = latestScopeKey;
              restoringBackupScopeKey = '';
              restoreLatestBackupPromise = null;
            });
        }

        await restoreLatestBackupPromise;
      } finally {
        if (!cancelled) {
          setChecking(false);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [apiBase, isAuthenticated, managementKey, checkAuth]);

  if (checking) {
    return (
      <div className="main-content">
        <LoadingSpinner />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}
