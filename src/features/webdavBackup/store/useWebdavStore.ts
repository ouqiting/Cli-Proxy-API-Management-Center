import { create } from 'zustand';
import type {
  WebdavConnectionConfig,
  ConnectionStatus,
  BackupScope,
  AutoBackupInterval,
} from '../types';
import {
  clearLegacyWebdavSettings,
  DEFAULT_PERSISTED_WEBDAV_SETTINGS,
  loadWebdavSettingsFromConfig,
  readLegacyWebdavSettings,
  saveWebdavSettingsToConfig,
  type PersistedWebdavSettings,
} from '../configPersistence';

interface PersistOptions {
  persist?: boolean;
}

interface WebdavStoreState extends PersistedWebdavSettings {
  // 运行时字段
  connectionStatus: ConnectionStatus;
  isBackingUp: boolean;
  isRestoring: boolean;
  isLoadingHistory: boolean;
  isHydrating: boolean;
  hasHydrated: boolean;
  persistError: string | null;

  // 操作
  hydrateFromConfig: (force?: boolean) => Promise<void>;
  persistCurrentSettings: () => Promise<void>;
  setConnection: (config: Partial<WebdavConnectionConfig>, options?: PersistOptions) => void;
  setBackupScope: (scope: Partial<BackupScope>, options?: PersistOptions) => void;
  setAutoBackupEnabled: (enabled: boolean, options?: PersistOptions) => void;
  setAutoBackupInterval: (interval: AutoBackupInterval, options?: PersistOptions) => void;
  setMaxBackupCount: (count: number, options?: PersistOptions) => void;
  setLastBackupTime: (time: string | null, options?: PersistOptions) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setIsBackingUp: (val: boolean) => void;
  setIsRestoring: (val: boolean) => void;
  setIsLoadingHistory: (val: boolean) => void;
}

function extractPersistedState(state: WebdavStoreState): PersistedWebdavSettings {
  return {
    connection: state.connection,
    backupScope: state.backupScope,
    autoBackupEnabled: state.autoBackupEnabled,
    autoBackupInterval: state.autoBackupInterval,
    maxBackupCount: state.maxBackupCount,
    lastBackupTime: state.lastBackupTime,
  };
}

let persistQueue: Promise<void> = Promise.resolve();
let hydrateQueue: Promise<void> | null = null;

export const useWebdavStore = create<WebdavStoreState>((set, get) => {
  const queuePersist = (options?: PersistOptions) => {
    if (options?.persist === false) return;
    if (!get().hasHydrated || get().isHydrating) return;
    void get().persistCurrentSettings();
  };

  return {
    ...DEFAULT_PERSISTED_WEBDAV_SETTINGS,

    connectionStatus: 'idle',
    isBackingUp: false,
    isRestoring: false,
    isLoadingHistory: false,
    isHydrating: false,
    hasHydrated: false,
    persistError: null,

    hydrateFromConfig: async (force = false) => {
      if (!force) {
        if (get().hasHydrated) return;
        if (hydrateQueue) return hydrateQueue;
      }

      set({ isHydrating: true, persistError: null });

      hydrateQueue = (async () => {
        try {
          const { settings, exists } = await loadWebdavSettingsFromConfig();
          const legacySettings = exists ? null : readLegacyWebdavSettings();
          const nextSettings = legacySettings ?? settings;

          set({
            ...nextSettings,
            isHydrating: false,
            hasHydrated: true,
            persistError: null,
          });

          if (legacySettings) {
            await saveWebdavSettingsToConfig(nextSettings);
            clearLegacyWebdavSettings();
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Failed to load WebDAV settings';
          console.warn('[WebDAV Backup] Failed to hydrate settings from config.yaml:', error);
          set({
            ...DEFAULT_PERSISTED_WEBDAV_SETTINGS,
            isHydrating: false,
            hasHydrated: true,
            persistError: message,
          });
        } finally {
          hydrateQueue = null;
        }
      })();

      return hydrateQueue;
    },

    persistCurrentSettings: async () => {
      const snapshot = extractPersistedState(get());
      persistQueue = persistQueue
        .catch(() => undefined)
        .then(async () => {
          await saveWebdavSettingsToConfig(snapshot);
          set({ persistError: null });
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : 'Failed to persist WebDAV settings';
          console.warn('[WebDAV Backup] Failed to persist settings to config.yaml:', error);
          set({ persistError: message });
          throw error;
        });

      return persistQueue;
    },

    setConnection: (config, options) => {
      set((state) => ({
        connection: { ...state.connection, ...config },
      }));
      queuePersist(options);
    },

    setBackupScope: (scope, options) => {
      set((state) => ({
        backupScope: { ...state.backupScope, ...scope },
      }));
      queuePersist(options);
    },

    setAutoBackupEnabled: (enabled, options) => {
      set({ autoBackupEnabled: enabled });
      queuePersist(options);
    },

    setAutoBackupInterval: (interval, options) => {
      set({ autoBackupInterval: interval });
      queuePersist(options);
    },

    setMaxBackupCount: (count, options) => {
      set({ maxBackupCount: Math.max(0, Math.trunc(count)) });
      queuePersist(options);
    },

    setLastBackupTime: (time, options) => {
      set({ lastBackupTime: time });
      queuePersist(options);
    },

    setConnectionStatus: (status) => set({ connectionStatus: status }),
    setIsBackingUp: (val) => set({ isBackingUp: val }),
    setIsRestoring: (val) => set({ isRestoring: val }),
    setIsLoadingHistory: (val) => set({ isLoadingHistory: val }),
  };
});
