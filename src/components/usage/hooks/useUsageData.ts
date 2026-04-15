import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { USAGE_STATS_STALE_TIME_MS, useNotificationStore, useUsageStatsStore } from '@/stores';
import { usageApi } from '@/services/api/usage';
import { webuiDataApi } from '@/services/api/webuiData';
import { downloadBlob } from '@/utils/download';
import {
  loadModelPrices,
  calculateRecentPerMinuteRates,
  calculateTotalCost,
  saveModelPrices,
  type ModelPrice,
} from '@/utils/usage';

export interface UsagePayload {
  total_requests?: number;
  success_count?: number;
  failure_count?: number;
  total_tokens?: number;
  apis?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UseUsageDataReturn {
  usage: UsagePayload | null;
  loading: boolean;
  error: string;
  lastRefreshedAt: Date | null;
  modelPrices: Record<string, ModelPrice>;
  setModelPrices: (prices: Record<string, ModelPrice>) => void;
  loadUsage: () => Promise<void>;
  handleExport: () => Promise<void>;
  handleImport: () => void;
  handleImportChange: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  importInputRef: React.RefObject<HTMLInputElement | null>;
  exporting: boolean;
  importing: boolean;
  persistedRpm: number | null;
  persistedTpm: number | null;
  persistedTotalCost: number | null;
}

const USAGE_STATS_STORAGE_KEY = 'cli-proxy-usage-stats-v1';
const USAGE_STATS_FILE_PATH = 'cli-proxy-usage-stats-v1.json';

interface PersistedUsageStats {
  modelPrices?: Record<string, ModelPrice>;
  rpm?: number;
  tpm?: number;
  totalCost?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const toFiniteNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeModelPrices = (value: unknown): Record<string, ModelPrice> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const normalized: Record<string, ModelPrice> = {};

  Object.entries(value).forEach(([modelName, price]) => {
    if (!modelName || !isRecord(price)) {
      return;
    }

    const prompt = Math.max(toFiniteNumber(price.prompt) ?? 0, 0);
    const completion = Math.max(toFiniteNumber(price.completion) ?? 0, 0);
    const cache = Math.max(toFiniteNumber(price.cache) ?? prompt, 0);

    normalized[modelName] = {
      prompt,
      completion,
      cache,
    };
  });

  return normalized;
};

const parsePersistedUsageStats = (raw: string | null | undefined): PersistedUsageStats => {
  if (!raw) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return {};
    }

    return {
      modelPrices: normalizeModelPrices(parsed.modelPrices),
      rpm: toFiniteNumber(parsed.rpm),
      tpm: toFiniteNumber(parsed.tpm),
      totalCost: toFiniteNumber(parsed.totalCost),
    };
  } catch {
    return {};
  }
};

const mergePersistedUsageStats = (
  base: PersistedUsageStats,
  patch: PersistedUsageStats
): PersistedUsageStats => ({
  modelPrices: patch.modelPrices ?? base.modelPrices,
  rpm: patch.rpm ?? base.rpm,
  tpm: patch.tpm ?? base.tpm,
  totalCost: patch.totalCost ?? base.totalCost,
});

export function useUsageData(): UseUsageDataReturn {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const usageSnapshot = useUsageStatsStore((state) => state.usage);
  const loading = useUsageStatsStore((state) => state.loading);
  const storeError = useUsageStatsStore((state) => state.error);
  const lastRefreshedAtTs = useUsageStatsStore((state) => state.lastRefreshedAt);
  const loadUsageStats = useUsageStatsStore((state) => state.loadUsageStats);

  const [modelPrices, setModelPrices] = useState<Record<string, ModelPrice>>({});
  const [persistedRpm, setPersistedRpm] = useState<number | null>(null);
  const [persistedTpm, setPersistedTpm] = useState<number | null>(null);
  const [persistedTotalCost, setPersistedTotalCost] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [storageHydrated, setStorageHydrated] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const applyPersistedUsageStats = useCallback((stats: PersistedUsageStats) => {
    if (stats.modelPrices !== undefined) {
      setModelPrices(stats.modelPrices);
    }
    if (typeof stats.rpm === 'number') {
      setPersistedRpm(stats.rpm);
    }
    if (typeof stats.tpm === 'number') {
      setPersistedTpm(stats.tpm);
    }
    if (typeof stats.totalCost === 'number') {
      setPersistedTotalCost(stats.totalCost);
    }
  }, []);

  const persistUsageStats = useCallback((patch: PersistedUsageStats) => {
    const localRaw =
      typeof localStorage === 'undefined' ? null : localStorage.getItem(USAGE_STATS_STORAGE_KEY);
    const current = parsePersistedUsageStats(localRaw);
    const next = mergePersistedUsageStats(current, patch);
    const content = JSON.stringify(next);

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(USAGE_STATS_STORAGE_KEY, content);
      }
    } catch {
      // Ignore storage errors.
    }

    if (next.modelPrices !== undefined) {
      saveModelPrices(next.modelPrices);
    }

    webuiDataApi.writeTextFile(USAGE_STATS_FILE_PATH, content).catch(() => {});
  }, []);

  const loadUsage = useCallback(async () => {
    await loadUsageStats({ force: true, staleTimeMs: USAGE_STATS_STALE_TIME_MS });
  }, [loadUsageStats]);

  useEffect(() => {
    void loadUsageStats({ staleTimeMs: USAGE_STATS_STALE_TIME_MS }).catch(() => {});
    const localPersisted = parsePersistedUsageStats(
      typeof localStorage === 'undefined' ? null : localStorage.getItem(USAGE_STATS_STORAGE_KEY)
    );
    const legacyModelPrices = loadModelPrices();
    const initialPersisted =
      localPersisted.modelPrices === undefined && Object.keys(legacyModelPrices).length > 0
        ? mergePersistedUsageStats(localPersisted, { modelPrices: legacyModelPrices })
        : localPersisted;

    applyPersistedUsageStats(initialPersisted);

    let cancelled = false;

    webuiDataApi
      .readTextFile(USAGE_STATS_FILE_PATH)
      .then((content) => {
        if (cancelled || !content) {
          return;
        }

        const remotePersisted = parsePersistedUsageStats(content);
        const mergedPersisted = mergePersistedUsageStats(remotePersisted, initialPersisted);
        applyPersistedUsageStats(mergedPersisted);

        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(USAGE_STATS_STORAGE_KEY, JSON.stringify(mergedPersisted));
          }
        } catch {
          // Ignore storage errors.
        }

        if (mergedPersisted.modelPrices !== undefined) {
          saveModelPrices(mergedPersisted.modelPrices);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setStorageHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applyPersistedUsageStats, loadUsageStats]);

  const usage = usageSnapshot as UsagePayload | null;

  useEffect(() => {
    if (!storageHydrated || !usage) return;
    const rateStats = calculateRecentPerMinuteRates(30, usage);
    const cost = calculateTotalCost(usage, modelPrices);

    setPersistedRpm(rateStats.rpm);
    setPersistedTpm(rateStats.tpm);
    setPersistedTotalCost(cost);

    persistUsageStats({
      modelPrices,
      rpm: rateStats.rpm,
      tpm: rateStats.tpm,
      totalCost: cost,
    });
  }, [modelPrices, persistUsageStats, storageHydrated, usage]);

  const handleSetModelPrices = useCallback(
    (prices: Record<string, ModelPrice>) => {
      setModelPrices(prices);
      const cost = usage ? calculateTotalCost(usage, prices) : (persistedTotalCost ?? 0);
      setPersistedTotalCost(cost);

      persistUsageStats({
        modelPrices: prices,
        totalCost: cost,
      });
    },
    [persistUsageStats, persistedTotalCost, usage]
  );

  const handleExport = async () => {
    setExporting(true);
    try {
      const data = await usageApi.exportUsage();
      const exportedAt =
        typeof data?.exported_at === 'string' ? new Date(data.exported_at) : new Date();
      const safeTimestamp = Number.isNaN(exportedAt.getTime())
        ? new Date().toISOString()
        : exportedAt.toISOString();
      const filename = `usage-export-${safeTimestamp.replace(/[:.]/g, '-')}.json`;
      downloadBlob({
        filename,
        blob: new Blob([JSON.stringify(data ?? {}, null, 2)], { type: 'application/json' }),
      });
      showNotification(t('usage_stats.export_success'), 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      showNotification(
        `${t('notification.download_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      setExporting(false);
    }
  };

  const handleImport = () => {
    importInputRef.current?.click();
  };

  const handleImportChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setImporting(true);
    try {
      const text = await file.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        showNotification(t('usage_stats.import_invalid'), 'error');
        return;
      }

      const result = await usageApi.importUsage(payload);
      showNotification(
        t('usage_stats.import_success', {
          added: result?.added ?? 0,
          skipped: result?.skipped ?? 0,
          total: result?.total_requests ?? 0,
          failed: result?.failed_requests ?? 0,
        }),
        'success'
      );
      try {
        await loadUsageStats({ force: true, staleTimeMs: USAGE_STATS_STALE_TIME_MS });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : '';
        showNotification(
          `${t('notification.refresh_failed')}${message ? `: ${message}` : ''}`,
          'error'
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      showNotification(
        `${t('notification.upload_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      setImporting(false);
    }
  };

  const error = storeError || '';
  const lastRefreshedAt = lastRefreshedAtTs ? new Date(lastRefreshedAtTs) : null;

  return {
    usage,
    loading,
    error,
    lastRefreshedAt,
    modelPrices,
    setModelPrices: handleSetModelPrices,
    loadUsage,
    handleExport,
    handleImport,
    handleImportChange,
    importInputRef,
    exporting,
    importing,
    persistedRpm,
    persistedTpm,
    persistedTotalCost,
  };
}
