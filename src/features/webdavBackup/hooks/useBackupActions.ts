import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotificationStore, useAuthStore } from '@/stores';
import { configApi, usageApi, webuiDataApi } from '@/services/api';
import { readQuotaSnapshotRaw, writeQuotaSnapshotRaw } from '@/services/quotaSnapshot';
import { collectUsageDetails, filterUsageByExcludedSources } from '@/utils/usage';
import {
  collectLoggingDisabledApiKeys,
  collectLoggingDisabledSourceIds,
} from '@/utils/apiKeySettings';
import { webdavClient } from '../client/webdavClient';
import { useWebdavStore } from '../store/useWebdavStore';
import type { BackupPayload, BackupData, BackupScope, WebdavFileInfo } from '../types';
import { LATEST_LOCAL_BACKUP_PATH } from '../constants';
import {
  deleteLocalBackup,
  listLocalBackups,
  readLocalBackup,
  saveLocalBackup,
  type LocalBackupFileInfo,
} from '../localBackup';
import {
  generateBackupFilename,
  isBackupFile,
  encryptForBackup,
  decryptFromBackup,
} from '../utils';

const BACKUP_LOCALSTORAGE_EXCLUDED_KEYS = new Set([
  'cli-proxy-auth',
  'isLoggedIn',
  'apiBase',
  'apiUrl',
  'managementKey',
]);

function getAppVersion(): string {
  try {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function collectBackupData(scope: BackupScope): Promise<BackupData> {
  const data: BackupData = {};

  if (scope.localStorage) {
    const lsData: Record<string, string> = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || BACKUP_LOCALSTORAGE_EXCLUDED_KEYS.has(key)) continue;
      const val = localStorage.getItem(key);
      if (val !== null) lsData[key] = val;
    }
    data.localStorage = lsData;
  }

  if (scope.config) {
    try {
      const cfg = await configApi.getRawConfig();
      data.config = cfg as Record<string, unknown>;
    } catch (err) {
      console.warn('[WebDAV Backup] Failed to fetch config:', err);
    }
  }

  if (scope.usage) {
    let rawConfigForUsageFilter: Record<string, unknown> | null = null;
    if (!scope.config) {
      try {
        const cfg = await configApi.getRawConfig();
        rawConfigForUsageFilter = cfg as Record<string, unknown>;
      } catch (err) {
        console.warn('[WebDAV Backup] Failed to fetch config for usage filter:', err);
      }
    }

    try {
      const usage = await usageApi.exportUsage();
      const rawConfig = rawConfigForUsageFilter ?? data.config;
      const excludedSources = collectLoggingDisabledSourceIds(rawConfig);
      const excludedApiKeys = collectLoggingDisabledApiKeys(rawConfig);
      const usageRecord =
        usage && typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : {};
      const rawUsage = usageRecord.usage;
      data.usage = {
        ...usageRecord,
        usage: filterUsageByExcludedSources(rawUsage, excludedSources, excludedApiKeys),
      };
    } catch (err) {
      console.warn('[WebDAV Backup] Failed to export usage:', err);
    }

    try {
      const quotaSnapshot = await readQuotaSnapshotRaw();
      if (quotaSnapshot !== null) {
        data.webuiData = { quotaSnapshot };
      }
    } catch (err) {
      console.warn('[WebDAV Backup] Failed to export quota snapshot:', err);
    }
  }

  return data;
}

function buildPayload(data: BackupData): BackupPayload {
  const authState = useAuthStore.getState();
  const encryptedData = encryptForBackup(JSON.stringify(data));
  return {
    version: 2,
    format: 'cpamc-backup',
    createdAt: new Date().toISOString(),
    source: {
      appVersion: getAppVersion(),
      apiBase: authState.apiBase,
      serverVersion: authState.serverVersion,
    },
    data: encryptedData,
  };
}

const AUTO_RESTORE_SCOPE: BackupScope = {
  localStorage: true,
  config: false,
  usage: true,
};

const isValidBackupPayload = (payload: unknown): payload is BackupPayload => {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  const candidate = payload as Partial<BackupPayload>;
  return (
    candidate.format === 'cpamc-backup' &&
    (candidate.version === 1 || candidate.version === 2) &&
    typeof candidate.createdAt === 'string'
  );
};

const isUsageSnapshotEmpty = (payload: unknown): boolean => {
  const usage =
    typeof payload === 'object' && payload !== null && 'usage' in payload
      ? (payload as { usage?: unknown }).usage
      : payload;
  return collectUsageDetails(usage).length === 0;
};

const parseBackupPayload = (raw: string): BackupPayload => {
  const payload = JSON.parse(raw) as unknown;
  if (!isValidBackupPayload(payload)) {
    throw new Error('Invalid backup payload');
  }
  return payload;
};

async function readLatestLocalBackupPayload(): Promise<BackupPayload | null> {
  try {
    const raw = await webuiDataApi.readTextFile(LATEST_LOCAL_BACKUP_PATH);
    return parseBackupPayload(raw);
  } catch (error) {
    if (webuiDataApi.isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function restoreLatestLocalBackupIfNeeded(): Promise<boolean> {
  const currentUsageResponse = await usageApi.getUsage();
  const currentUsage = currentUsageResponse?.usage ?? currentUsageResponse;
  if (!isUsageSnapshotEmpty(currentUsage)) {
    return false;
  }

  const payload = await readLatestLocalBackupPayload();
  if (!payload) {
    return false;
  }

  const backupData = extractData(payload);
  const hasRestorableUsage = !isUsageSnapshotEmpty(backupData.usage);
  const hasQuotaSnapshot =
    typeof backupData.webuiData?.quotaSnapshot === 'string' &&
    backupData.webuiData.quotaSnapshot.trim() !== '';
  const hasLocalStorage = Object.keys(backupData.localStorage ?? {}).length > 0;

  if (!hasRestorableUsage && !hasQuotaSnapshot && !hasLocalStorage) {
    return false;
  }

  await applyRestore(payload, AUTO_RESTORE_SCOPE);
  return true;
}

export function useBackupActions() {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();

  const loadLocalHistory = useCallback(async (): Promise<LocalBackupFileInfo[]> => {
    try {
      return await listLocalBackups();
    } catch (err) {
      console.error('[Local Backup] List failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      showNotification(`${t('backup.list_failed')}: ${msg}`, 'error');
      return [];
    }
  }, [showNotification, t]);

  const performBackup = useCallback(
    async ({ throwOnError = false, localOnly = false }: { throwOnError?: boolean; localOnly?: boolean } = {}) => {
      const { connection, backupScope, maxBackupCount, setIsBackingUp, setLastBackupTime, setLastWebdavBackupTime } =
        useWebdavStore.getState();

      setIsBackingUp(true);
      try {
        const data = await collectBackupData(backupScope);
        const payload = buildPayload(data);
        const filename = generateBackupFilename();
        const payloadJson = JSON.stringify(payload, null, 2);

        await saveLocalBackup(filename, payloadJson, maxBackupCount);

        const now = new Date().toISOString();
        setLastBackupTime(now);

        let remoteError: Error | null = null;
        if (connection.serverUrl && !localOnly) {
          try {
            await webdavClient.ensureDirectory(connection);
            await webdavClient.putFile(connection, filename, payloadJson);
            
            setLastWebdavBackupTime(now);

            if (maxBackupCount > 0) {
              try {
                const files = await webdavClient.listDirectory(connection);
                const backupFiles = files
                  .filter((f) => !f.isCollection && isBackupFile(f.displayName))
                  .sort((a, b) => {
                    const da = new Date(a.lastModified).getTime() || 0;
                    const db = new Date(b.lastModified).getTime() || 0;
                    return db - da;
                  });
                if (backupFiles.length > maxBackupCount) {
                  const toDelete = backupFiles.slice(maxBackupCount);
                  let deleted = 0;
                  for (const f of toDelete) {
                    try {
                      await webdavClient.deleteFile(connection, f.displayName);
                      deleted++;
                    } catch (delErr) {
                      console.warn(`[WebDAV Backup] Failed to delete ${f.displayName}:`, delErr);
                    }
                  }
                  if (deleted > 0) {
                    console.log(
                      `[WebDAV Backup] Cleaned up ${deleted}/${toDelete.length} old backup(s)`
                    );
                  }
                }
              } catch (cleanupErr) {
                console.warn('[WebDAV Backup] Cleanup failed:', cleanupErr);
              }
            }
          } catch (err) {
            remoteError = err instanceof Error ? err : new Error(String(err));
            console.warn('[WebDAV Backup] Remote backup failed after local success:', err);
          }
        }

        if (remoteError) {
          showNotification(
            t('backup.backup_partial_success', { message: remoteError.message }),
            'warning'
          );
        } else {
          showNotification(t('backup.backup_success'), 'success');
        }

        return true;
      } catch (err) {
        console.error('[WebDAV Backup] Backup failed:', err);
        const msg = err instanceof Error ? err.message : String(err);
        const backupError = err instanceof Error ? err : new Error(msg);
        showNotification(`${t('backup.backup_failed')}: ${msg}`, 'error');
        if (throwOnError) {
          throw backupError;
        }
        return false;
      } finally {
        setIsBackingUp(false);
      }
    },
    [t, showNotification]
  );

  const backup = useCallback(() => performBackup({ localOnly: false }), [performBackup]);

  const backupOrThrow = useCallback(async () => {
    await performBackup({ throwOnError: true, localOnly: false });
  }, [performBackup]);

  const autoBackup = useCallback(async ({ localOnly = false }: { localOnly?: boolean } = {}) => {
    await performBackup({ localOnly });
  }, [performBackup]);

  const exportLocal = useCallback(async () => {
    const { backupScope } = useWebdavStore.getState();
    try {
      const data = await collectBackupData(backupScope);
      const payload = buildPayload(data);
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = generateBackupFilename();
      a.click();
      URL.revokeObjectURL(url);
      showNotification(t('backup.export_success'), 'success');
    } catch (err) {
      console.error('[WebDAV Backup] Export failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      showNotification(`${t('backup.export_failed')}: ${msg}`, 'error');
    }
  }, [t, showNotification]);

  const loadHistory = useCallback(async (): Promise<WebdavFileInfo[]> => {
    const { connection, setIsLoadingHistory } = useWebdavStore.getState();
    if (!connection.serverUrl) return [];

    setIsLoadingHistory(true);
    try {
      const files = await webdavClient.listDirectory(connection);
      return files
        .filter((f) => isBackupFile(f.displayName))
        .sort((a, b) => {
          const da = new Date(a.lastModified).getTime() || 0;
          const db = new Date(b.lastModified).getTime() || 0;
          return db - da;
        });
    } catch (err) {
      console.error('[WebDAV Backup] List failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      showNotification(`${t('backup.list_failed')}: ${msg}`, 'error');
      return [];
    } finally {
      setIsLoadingHistory(false);
    }
  }, [t, showNotification]);

  const downloadFile = useCallback(
    async (filename: string) => {
      const { connection } = useWebdavStore.getState();
      try {
        const content = await webdavClient.getFile(connection, filename);
        const blob = new Blob([content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('[WebDAV Backup] Download failed:', err);
        const msg = err instanceof Error ? err.message : String(err);
        showNotification(`${t('backup.download_failed')}: ${msg}`, 'error');
      }
    },
    [t, showNotification]
  );

  const downloadLocalFile = useCallback(
    async (filename: string) => {
      try {
        const content = await readLocalBackup(filename);
        const blob = new Blob([content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('[Local Backup] Download failed:', err);
        const msg = err instanceof Error ? err.message : String(err);
        showNotification(`${t('backup.download_failed')}: ${msg}`, 'error');
      }
    },
    [showNotification, t]
  );

  const deleteRemote = useCallback(
    async (filename: string) => {
      const { connection } = useWebdavStore.getState();
      try {
        await webdavClient.deleteFile(connection, filename);
        showNotification(t('backup.delete_success'), 'success');
      } catch (err) {
        console.error('[WebDAV Backup] Delete failed:', err);
        const msg = err instanceof Error ? err.message : String(err);
        showNotification(`${t('backup.delete_failed')}: ${msg}`, 'error');
      }
    },
    [t, showNotification]
  );

  const deleteLocal = useCallback(
    async (filename: string) => {
      try {
        await deleteLocalBackup(filename);
        showNotification(t('backup.delete_success'), 'success');
      } catch (err) {
        console.error('[Local Backup] Delete failed:', err);
        const msg = err instanceof Error ? err.message : String(err);
        showNotification(`${t('backup.delete_failed')}: ${msg}`, 'error');
      }
    },
    [showNotification, t]
  );

  const restore = useCallback(
    async (filename: string, scope: BackupScope) => {
      const { connection, setIsRestoring } = useWebdavStore.getState();
      setIsRestoring(true);
      try {
        const content = await webdavClient.getFile(connection, filename);
        const payload: BackupPayload = JSON.parse(content);

        if (payload.format !== 'cpamc-backup' || (payload.version !== 1 && payload.version !== 2)) {
          showNotification(t('backup.invalid_format'), 'error');
          return;
        }

        await applyRestore(payload, scope);
        showNotification(t('backup.restore_success'), 'success');
      } catch (err) {
        console.error('[WebDAV Backup] Restore failed:', err);
        const msg = err instanceof Error ? err.message : String(err);
        showNotification(`${t('backup.restore_failed')}: ${msg}`, 'error');
      } finally {
        setIsRestoring(false);
      }
    },
    [t, showNotification]
  );

  const restoreLocalBackup = useCallback(
    async (filename: string, scope: BackupScope) => {
      const { setIsRestoring } = useWebdavStore.getState();
      setIsRestoring(true);
      try {
        const text = await readLocalBackup(filename);
        const payload: BackupPayload = JSON.parse(text);

        if (payload.format !== 'cpamc-backup' || (payload.version !== 1 && payload.version !== 2)) {
          showNotification(t('backup.invalid_format'), 'error');
          return;
        }

        await applyRestore(payload, scope);
        showNotification(t('backup.restore_success'), 'success');
      } catch (err) {
        console.error('[Local Backup] Restore failed:', err);
        const msg = err instanceof Error ? err.message : String(err);
        showNotification(`${t('backup.restore_failed')}: ${msg}`, 'error');
      } finally {
        setIsRestoring(false);
      }
    },
    [showNotification, t]
  );

  const restoreFromLocal = useCallback(
    async (file: File, scope: BackupScope) => {
      const { setIsRestoring } = useWebdavStore.getState();
      setIsRestoring(true);
      try {
        const text = await file.text();
        const payload: BackupPayload = JSON.parse(text);

        if (payload.format !== 'cpamc-backup' || (payload.version !== 1 && payload.version !== 2)) {
          showNotification(t('backup.invalid_format'), 'error');
          return;
        }

        await applyRestore(payload, scope);
        showNotification(t('backup.restore_success'), 'success');
      } catch (err) {
        console.error('[WebDAV Backup] Local restore failed:', err);
        const msg = err instanceof Error ? err.message : String(err);
        showNotification(`${t('backup.restore_failed')}: ${msg}`, 'error');
      } finally {
        setIsRestoring(false);
      }
    },
    [t, showNotification]
  );

  const deleteAllBackupFiles = useCallback(async () => {
    const { connection } = useWebdavStore.getState();
    let failedCount = 0;

    try {
      const localFiles = await listLocalBackups();
      for (const file of localFiles) {
        try {
          await deleteLocalBackup(file.filename);
        } catch (err) {
          failedCount++;
          console.warn('[All Backup Delete] Failed to delete local:', file.filename, err);
        }
      }
    } catch (err) {
      console.warn('[All Backup Delete] Failed to list local backups:', err);
    }

    if (connection.serverUrl) {
      try {
        const files = await webdavClient.listDirectory(connection);
        const backupFiles = files.filter(
          (f) => !f.isCollection && isBackupFile(f.displayName)
        );
        for (const file of backupFiles) {
          try {
            await webdavClient.deleteFile(connection, file.displayName);
          } catch (err) {
            failedCount++;
            console.warn('[All Backup Delete] Failed to delete cloud:', file.displayName, err);
          }
        }
      } catch (err) {
        console.warn('[All Backup Delete] Failed to list cloud backups:', err);
      }
    }

    if (failedCount > 0) {
      showNotification(
        `${t('backup.delete_all_success')}（${failedCount} ${t('backup.delete_all_failed_count')}）`,
        'warning'
      );
    } else {
      showNotification(t('backup.delete_all_success'), 'success');
    }
  }, [t, showNotification]);

  return {
    backup,
    backupOrThrow,
    autoBackup,
    exportLocal,
    loadLocalHistory,
    loadHistory,
    downloadFile,
    downloadLocalFile,
    deleteLocal,
    deleteRemote,
    deleteAllBackupFiles,
    restore,
    restoreLocalBackup,
    restoreFromLocal,
  };
}

/**
 * 从 payload 中提取 data：v2 加密格式需要解密，v1 旧格式直接使用
 */
function extractData(payload: BackupPayload): BackupData {
  if (typeof payload.data === 'string') {
    const decrypted = decryptFromBackup(payload.data);
    return JSON.parse(decrypted) as BackupData;
  }
  return payload.data;
}

async function applyRestore(payload: BackupPayload, scope: BackupScope): Promise<void> {
  const data = extractData(payload);

  if (scope.localStorage && data.localStorage) {
    for (const [key, val] of Object.entries(data.localStorage)) {
      localStorage.setItem(key, val);
      if (key === 'cli-proxy-usage-stats-v1') {
        webuiDataApi.writeTextFile('cli-proxy-usage-stats-v1.json', val).catch(() => {});
      }
    }
  }

  if (scope.usage && data.usage) {
    try {
      await usageApi.importUsage(data.usage);
    } catch (err) {
      console.warn('[WebDAV Backup] Usage import failed:', err);
    }
  }

  if (scope.usage && typeof data.webuiData?.quotaSnapshot === 'string') {
    try {
      await writeQuotaSnapshotRaw(data.webuiData.quotaSnapshot);
    } catch (err) {
      console.warn('[WebDAV Backup] Quota snapshot restore failed:', err);
    }
  }

  // config 只提供查看，不自动写入后端
}
