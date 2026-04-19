import { webuiDataApi, usageApi } from '@/services/api';
import { collectUsageDetails } from '@/utils/usage';

export const FRONTEND_STATE_PATH = 'state/frontend-state.json';
export const RUNTIME_USAGE_SNAPSHOT_PATH = 'state/runtime-usage.json';
export const FRONTEND_SYNC_DEBOUNCE_MS = 1500;
export const RUNTIME_SYNC_INTERVAL_MS = 2 * 60 * 1000;
export const LOCAL_STATE_EXCLUDED_KEYS = new Set([
  'cli-proxy-auth',
  'isLoggedIn',
  'apiBase',
  'apiUrl',
  'managementKey',
]);

interface FrontendStateSnapshot {
  version: 1;
  updatedAt: string;
  localStorage: Record<string, string>;
}

let frontendSyncInstalled = false;
let suppressFrontendSync = false;
let frontendSyncTimer: ReturnType<typeof setTimeout> | null = null;
let frontendSyncQueue: Promise<void> = Promise.resolve();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const getLocalStorageSnapshot = (): Record<string, string> => {
  if (typeof window === 'undefined') {
    return {};
  }

  const snapshot: Record<string, string> = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key || LOCAL_STATE_EXCLUDED_KEYS.has(key)) continue;
    const value = window.localStorage.getItem(key);
    if (value !== null) {
      snapshot[key] = value;
    }
  }
  return snapshot;
};

const serializeFrontendState = (): string =>
  JSON.stringify(
    {
      version: 1,
      updatedAt: new Date().toISOString(),
      localStorage: getLocalStorageSnapshot(),
    } satisfies FrontendStateSnapshot,
    null,
    2
  );

async function writeFrontendStateSnapshotNow(): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  frontendSyncQueue = frontendSyncQueue
    .catch(() => undefined)
    .then(() => webuiDataApi.writeTextFile(FRONTEND_STATE_PATH, serializeFrontendState()))
    .catch((error) => {
      console.warn('[Local Persistence] Failed to persist frontend state:', error);
    });

  return frontendSyncQueue;
}

export function scheduleFrontendStatePersist(delayMs = FRONTEND_SYNC_DEBOUNCE_MS): void {
  if (typeof window === 'undefined' || suppressFrontendSync) {
    return;
  }

  if (frontendSyncTimer) {
    clearTimeout(frontendSyncTimer);
  }

  frontendSyncTimer = window.setTimeout(() => {
    frontendSyncTimer = null;
    void writeFrontendStateSnapshotNow();
  }, Math.max(0, delayMs));
}

export async function flushFrontendStatePersist(): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  if (frontendSyncTimer) {
    clearTimeout(frontendSyncTimer);
    frontendSyncTimer = null;
  }

  await writeFrontendStateSnapshotNow();
}

const patchStoragePrototype = () => {
  const storageProto = Storage.prototype as Storage & {
    __cpamcLocalPersistencePatched?: boolean;
    __cpamcLocalPersistenceOriginalSetItem?: Storage['setItem'];
    __cpamcLocalPersistenceOriginalRemoveItem?: Storage['removeItem'];
    __cpamcLocalPersistenceOriginalClear?: Storage['clear'];
  };

  if (storageProto.__cpamcLocalPersistencePatched) {
    return;
  }

  storageProto.__cpamcLocalPersistencePatched = true;
  storageProto.__cpamcLocalPersistenceOriginalSetItem = storageProto.setItem;
  storageProto.__cpamcLocalPersistenceOriginalRemoveItem = storageProto.removeItem;
  storageProto.__cpamcLocalPersistenceOriginalClear = storageProto.clear;

  storageProto.setItem = function patchedSetItem(this: Storage, key: string, value: string) {
    storageProto.__cpamcLocalPersistenceOriginalSetItem?.call(this, key, value);
    if (typeof window !== 'undefined' && this === window.localStorage) {
      scheduleFrontendStatePersist();
    }
  };

  storageProto.removeItem = function patchedRemoveItem(this: Storage, key: string) {
    storageProto.__cpamcLocalPersistenceOriginalRemoveItem?.call(this, key);
    if (typeof window !== 'undefined' && this === window.localStorage) {
      scheduleFrontendStatePersist();
    }
  };

  storageProto.clear = function patchedClear(this: Storage) {
    storageProto.__cpamcLocalPersistenceOriginalClear?.call(this);
    if (typeof window !== 'undefined' && this === window.localStorage) {
      scheduleFrontendStatePersist();
    }
  };
};

const parseFrontendStateSnapshot = (raw: string): FrontendStateSnapshot | null => {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed.localStorage)) {
    return null;
  }

  const localStorageEntries: Record<string, string> = {};
  Object.entries(parsed.localStorage).forEach(([key, value]) => {
    if (typeof value === 'string') {
      localStorageEntries[key] = value;
    }
  });

  return {
    version: 1,
    updatedAt:
      typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim()
        ? parsed.updatedAt
        : new Date().toISOString(),
    localStorage: localStorageEntries,
  };
};

export async function hydrateFrontendStateFromLocalFile(): Promise<FrontendStateSnapshot | null> {
  try {
    const raw = await webuiDataApi.readTextFile(FRONTEND_STATE_PATH);
    if (!raw.trim()) {
      return null;
    }

    const snapshot = parseFrontendStateSnapshot(raw);
    if (!snapshot) {
      return null;
    }

    if (typeof window !== 'undefined') {
      suppressFrontendSync = true;
      try {
        Object.entries(snapshot.localStorage).forEach(([key, value]) => {
          if (LOCAL_STATE_EXCLUDED_KEYS.has(key)) {
            return;
          }
          window.localStorage.setItem(key, value);
        });
      } finally {
        suppressFrontendSync = false;
      }
    }

    return snapshot;
  } catch (error) {
    if (webuiDataApi.isNotFoundError(error)) {
      return null;
    }
    console.warn('[Local Persistence] Failed to hydrate frontend state:', error);
    return null;
  }
}

export function installFrontendStateSync(): void {
  if (typeof window === 'undefined' || frontendSyncInstalled) {
    return;
  }

  patchStoragePrototype();

  const flushSoon = () => {
    void flushFrontendStatePersist().catch(() => {});
  };

  window.addEventListener('pagehide', flushSoon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushSoon();
    }
  });

  frontendSyncInstalled = true;
}

export async function initializeLocalPersistence(): Promise<FrontendStateSnapshot | null> {
  const snapshot = await hydrateFrontendStateFromLocalFile();
  installFrontendStateSync();
  return snapshot;
}

const isUsageSnapshotEmpty = (payload: unknown): boolean => collectUsageDetails(payload).length === 0;

export async function persistRuntimeUsageSnapshot(): Promise<void> {
  const exported = await usageApi.exportUsage();
  await webuiDataApi.writeTextFile(RUNTIME_USAGE_SNAPSHOT_PATH, JSON.stringify(exported ?? {}, null, 2));
}

export async function restoreRuntimeUsageSnapshotIfNeeded(): Promise<boolean> {
  const currentUsageResponse = await usageApi.getUsage();
  const currentUsage = currentUsageResponse?.usage ?? currentUsageResponse;
  if (!isUsageSnapshotEmpty(currentUsage)) {
    return false;
  }

  try {
    const raw = await webuiDataApi.readTextFile(RUNTIME_USAGE_SNAPSHOT_PATH);
    if (!raw.trim()) {
      return false;
    }

    const parsed: unknown = JSON.parse(raw);
    const usagePayload =
      isRecord(parsed) && isRecord(parsed.usage) ? parsed : isRecord(parsed) ? parsed : null;
    if (!usagePayload || isUsageSnapshotEmpty(usagePayload)) {
      return false;
    }

    await usageApi.importUsage(usagePayload);
    return true;
  } catch (error) {
    if (webuiDataApi.isNotFoundError(error)) {
      return false;
    }
    console.warn('[Local Persistence] Failed to restore runtime usage snapshot:', error);
    return false;
  }
}
