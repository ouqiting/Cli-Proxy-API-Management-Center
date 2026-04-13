/**
 * Quota management page - coordinates the quota sections.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import {
  useAuthStore,
  useDisabledCredentialsStore,
  useNotificationStore,
  useQuotaStore,
} from '@/stores';
import { useCodexBulkQueryStore } from '@/stores/useCodexBulkQueryStore';
import { authFilesApi, configFileApi, providersApi } from '@/services/api';
import {
  QuotaSection,
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CodexBulkQueryModal,
  CODEX_CONFIG,
  VERCEL_CONFIG,
  GEMINI_CLI_CONFIG,
  KIMI_CONFIG,
} from '@/components/quota';
import { Button } from '@/components/ui/Button';
import type { AuthFileItem, CodexQuotaWindow, OpenAIProviderConfig } from '@/types';
import type { DisableCredentialTarget } from '@/services/api/credentialDisable';
import {
  readQuotaSnapshot,
  type QuotaSnapshotChannel,
  type QuotaSnapshotQueryTimes,
  writeQuotaSnapshot,
} from '@/services/quotaSnapshot';
import { formatDateTime, maskApiKey } from '@/utils/format';
import { getStatusFromError } from '@/utils/quota';
import styles from './QuotaPage.module.scss';

const VERCEL_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1';

const normalizeQuotaOpenAIBaseUrl = (baseUrl: string): string => {
  let trimmed = String(baseUrl || '').trim();
  if (!trimmed) return '';
  trimmed = trimmed.replace(/\/?v0\/management\/?$/i, '');
  trimmed = trimmed.replace(/\/+$/g, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `http://${trimmed}`;
  }
  return trimmed.toLowerCase();
};

const formatQuotaAmount = (value: number) =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: Math.abs(value % 1) < 0.000_001 ? 0 : 2,
    maximumFractionDigits: 2,
  });

const parseCodexResetDayInfo = (resetLabel: string) => {
  const trimmed = String(resetLabel ?? '').trim();
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})/);
  if (!match) return null;

  const month = Number.parseInt(match[1], 10);
  const day = Number.parseInt(match[2], 10);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;

  const now = new Date();
  const candidate = new Date(now.getFullYear(), month - 1, day, 0, 0, 0, 0);
  if (candidate.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
    candidate.setFullYear(candidate.getFullYear() + 1);
  }

  return {
    dayKey: `${match[1]}/${match[2]}`,
    sortTime: candidate.getTime(),
  };
};

const getCodexWeeklyWindow = (
  file: AuthFileItem,
  codexQuota: Record<string, any>
): CodexQuotaWindow | null => {
  const quota = codexQuota[file.name];
  if (!quota || quota.status !== 'success' || !Array.isArray(quota.windows)) {
    return null;
  }

  const weeklyWindow = quota.windows.find((window: CodexQuotaWindow) => window.id === 'weekly');
  return weeklyWindow ?? null;
};

type CodexWeeklyCandidate = {
  file: AuthFileItem;
  remainingPercent: number | null;
  resetLabel: string;
  dayKey: string;
  sortTime: number;
};

type CodexWeeklyLimitPlan = {
  weeklyCandidates: CodexWeeklyCandidate[];
  keepNames: Set<string>;
  disableTargets: Set<string>;
  restoreTargets: Set<string>;
  candidateMap: Map<string, CodexWeeklyCandidate>;
  candidateOrderMap: Map<string, number>;
};

const compareCodexWeeklyCandidate = (
  left: CodexWeeklyCandidate,
  right: CodexWeeklyCandidate
): number => {
  if (left.sortTime !== right.sortTime) return left.sortTime - right.sortTime;
  if (left.resetLabel !== right.resetLabel) return left.resetLabel.localeCompare(right.resetLabel);
  return left.file.name.localeCompare(right.file.name);
};

const buildCodexWeeklyLimitPlan = (
  codexFiles: AuthFileItem[],
  codexQuota: Record<string, any>
): CodexWeeklyLimitPlan => {
  const weeklyCandidates = codexFiles
    .map((file) => {
      const weeklyWindow = getCodexWeeklyWindow(file, codexQuota);
      if (!weeklyWindow) return null;

      const usedPercent =
        typeof weeklyWindow.usedPercent === 'number' ? weeklyWindow.usedPercent : null;
      const remainingPercent =
        usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent));
      const dayInfo = parseCodexResetDayInfo(weeklyWindow.resetLabel);

      return {
        file,
        remainingPercent,
        resetLabel: weeklyWindow.resetLabel,
        dayKey: dayInfo?.dayKey ?? `unknown:${file.name}`,
        sortTime: dayInfo?.sortTime ?? Number.POSITIVE_INFINITY,
      } satisfies CodexWeeklyCandidate;
    })
    .filter(Boolean) as CodexWeeklyCandidate[];

  const sortedWeeklyCandidates = [...weeklyCandidates].sort(compareCodexWeeklyCandidate);
  const nonZeroWeekly = sortedWeeklyCandidates.filter(
    (item) => item.remainingPercent === null || item.remainingPercent > 0
  );

  const keepNames = new Set<string>();
  let keptCount = 0;
  let currentGroupKey = '';

  for (const item of nonZeroWeekly) {
    if (keptCount < 5) {
      keepNames.add(item.file.name);
      keptCount += 1;
      currentGroupKey = item.dayKey;
      continue;
    }

    if (item.dayKey === currentGroupKey) {
      keepNames.add(item.file.name);
      keptCount += 1;
      continue;
    }

    break;
  }

  const disableTargets = new Set<string>();
  const restoreTargets = new Set<string>();
  const candidateMap = new Map<string, CodexWeeklyCandidate>();
  const candidateOrderMap = new Map<string, number>();

  sortedWeeklyCandidates.forEach((item, index) => {
    candidateMap.set(item.file.name, item);
    candidateOrderMap.set(item.file.name, index);

    const shouldKeep = keepNames.has(item.file.name);
    const shouldDisable =
      (item.remainingPercent !== null && item.remainingPercent <= 0) || !shouldKeep;

    if (shouldDisable) {
      disableTargets.add(item.file.name);
      return;
    }

    restoreTargets.add(item.file.name);
  });

  return {
    weeklyCandidates: sortedWeeklyCandidates,
    keepNames,
    disableTargets,
    restoreTargets,
    candidateMap,
    candidateOrderMap,
  };
};

type QuotaStateMap<TState> = Record<string, TState>;

type QuotaStateWithStatus = {
  status: 'idle' | 'loading' | 'success' | 'error';
};

const hasLoadingQuota = <TState extends QuotaStateWithStatus>(
  map: QuotaStateMap<TState>
): boolean => Object.values(map).some((item) => item.status === 'loading');

export function QuotaPage() {
  const { t, i18n } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [openAIProviders, setOpenAIProviders] = useState<OpenAIProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [openAIProvidersLoading, setOpenAIProvidersLoading] = useState(true);
  const [error, setError] = useState('');
  const [codexQueryModalOpen, setCodexQueryModalOpen] = useState(false);
  const [deletingFailedConfigs, setDeletingFailedConfigs] = useState(false);
  const [credentialActionLoadingKey, setCredentialActionLoadingKey] = useState<string | null>(null);
  const [vercelBulkLoading, setVercelBulkLoading] = useState(false);
  const [codexWeeklyLimitLoading, setCodexWeeklyLimitLoading] = useState(false);
  const [quotaQueryTimes, setQuotaQueryTimes] = useState<QuotaSnapshotQueryTimes>({});
  const snapshotHydratedRef = useRef(false);
  const channelLoadingRef = useRef<Record<QuotaSnapshotChannel, boolean>>({
    antigravity: false,
    claude: false,
    codex: false,
    vercel: false,
    'gemini-cli': false,
    kimi: false,
  });

  const disableControls = connectionStatus !== 'connected';
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const codexHasEverRun = useCodexBulkQueryStore((state) => state.hasEverRun);
  const codexQueryStatus = useCodexBulkQueryStore((state) => state.status);
  const codexQueryTotal = useCodexBulkQueryStore((state) => state.total);
  const codexQueryCompleted = useCodexBulkQueryStore((state) => state.completed);
  const codexQueryErrorCount = useCodexBulkQueryStore((state) => state.errorCount);
  const codexQueryFailedItems = useCodexBulkQueryStore((state) => state.failedItems);
  const codexQueryLastStartedAt = useCodexBulkQueryStore((state) => state.lastStartedAt);
  const codexQueryLastFinishedAt = useCodexBulkQueryStore((state) => state.lastFinishedAt);
  const startCodexBulkQuery = useCodexBulkQueryStore((state) => state.startQuery);
  const stopCodexBulkQuery = useCodexBulkQueryStore((state) => state.stopQuery);
  const removeFailedCodexItems = useCodexBulkQueryStore((state) => state.removeFailedItems);
  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const vercelQuota = useQuotaStore((state) => state.vercelQuota);
  const geminiCliQuota = useQuotaStore((state) => state.geminiCliQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const setAntigravityQuota = useQuotaStore((state) => state.setAntigravityQuota);
  const setClaudeQuota = useQuotaStore((state) => state.setClaudeQuota);
  const setCodexQuota = useQuotaStore((state) => state.setCodexQuota);
  const setVercelQuota = useQuotaStore((state) => state.setVercelQuota);
  const setGeminiCliQuota = useQuotaStore((state) => state.setGeminiCliQuota);
  const setKimiQuota = useQuotaStore((state) => state.setKimiQuota);
  const disabledCredentialsSnapshot = useDisabledCredentialsStore((state) => state.snapshot);
  const refreshDisabledCredentialsSnapshot = useDisabledCredentialsStore(
    (state) => state.refreshSnapshot
  );
  const setCredentialDisabledState = useDisabledCredentialsStore(
    (state) => state.setTargetDisabledState
  );

  const vercelFiles = useMemo(() => {
    const items: AuthFileItem[] = [];

    openAIProviders.forEach((provider, providerIndex) => {
      const normalizedBaseUrl = normalizeQuotaOpenAIBaseUrl(provider.baseUrl);
      if (normalizedBaseUrl !== VERCEL_GATEWAY_BASE_URL) {
        return;
      }

      (provider.apiKeyEntries || []).forEach((entry, entryIndex) => {
        const apiKey = String(entry.apiKey ?? '').trim();
        if (!apiKey) return;

        const providerName = String(provider.name ?? '').trim() || `Vercel #${providerIndex + 1}`;
        const maskedKey = maskApiKey(apiKey);
        items.push({
          name: `${providerName} - Key #${entryIndex + 1} (${maskedKey})`,
          type: 'vercel',
          provider: 'vercel',
          disabled: false,
          apiKey,
          providerName,
          providerBaseUrl: provider.baseUrl,
          providerHeaders: provider.headers ?? {},
          entryHeaders: entry.headers ?? {},
        });
      });
    });

    (disabledCredentialsSnapshot?.disabledOpenAIEntries || []).forEach((entry, entryIndex) => {
      const normalizedBaseUrl = normalizeQuotaOpenAIBaseUrl(entry.provider.baseUrl);
      if (normalizedBaseUrl !== VERCEL_GATEWAY_BASE_URL) {
        return;
      }

      const apiKey = String(entry.entry.apiKey ?? '').trim();
      if (!apiKey) return;

      const providerName =
        String(entry.provider.name ?? '').trim() || `Vercel Disabled #${entryIndex + 1}`;
      const maskedKey = maskApiKey(apiKey);
      items.push({
        name: `${providerName} - Key (${maskedKey})`,
        type: 'vercel',
        provider: 'vercel',
        disabled: true,
        apiKey,
        providerName,
        providerBaseUrl: entry.provider.baseUrl,
        providerHeaders: entry.provider.headers ?? {},
        entryHeaders: entry.entry.headers ?? {},
      });
    });

    return items;
  }, [disabledCredentialsSnapshot?.disabledOpenAIEntries, openAIProviders]);

  const vercelTotalBalance = useMemo(() => {
    const values = Object.values(vercelQuota);
    const successful = values.filter(
      (item) => item.status === 'success' && typeof item.balance === 'number'
    );
    if (successful.length === 0) return null;
    return successful.reduce((sum, item) => sum + (item.balance ?? 0), 0);
  }, [vercelQuota]);

  const codexFiles = useMemo(
    () =>
      files.filter(
        (file) =>
          String(file.type ?? file.provider ?? '')
            .trim()
            .toLowerCase() === 'codex'
      ),
    [files]
  );

  const codexWeeklyLimitPlan = useMemo(
    () => buildCodexWeeklyLimitPlan(codexFiles, codexQuota),
    [codexFiles, codexQuota]
  );

  const sortCodexFilesByWeeklyReset = useCallback(
    (items: AuthFileItem[]) => {
      const copy = [...items];
      copy.sort((left, right) => {
        const leftCandidate = codexWeeklyLimitPlan.candidateMap.get(left.name);
        const rightCandidate = codexWeeklyLimitPlan.candidateMap.get(right.name);

        const getRank = (file: AuthFileItem, candidate?: CodexWeeklyCandidate) => {
          if (!candidate) return 3;
          if (codexWeeklyLimitPlan.keepNames.has(file.name)) return 0;
          if (candidate.remainingPercent === null || candidate.remainingPercent > 0) return 1;
          return 2;
        };

        const leftRank = getRank(left, leftCandidate);
        const rightRank = getRank(right, rightCandidate);
        if (leftRank !== rightRank) return leftRank - rightRank;

        const leftOrder = codexWeeklyLimitPlan.candidateOrderMap.get(left.name);
        const rightOrder = codexWeeklyLimitPlan.candidateOrderMap.get(right.name);
        if (leftOrder !== undefined && rightOrder !== undefined && leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }

        if (leftOrder !== undefined && rightOrder === undefined) return -1;
        if (leftOrder === undefined && rightOrder !== undefined) return 1;
        return left.name.localeCompare(right.name);
      });
      return copy;
    },
    [codexWeeklyLimitPlan]
  );

  const loadConfig = useCallback(async () => {
    try {
      await configFileApi.fetchConfigYaml();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError((prev) => prev || errorMessage);
    }
  }, [t]);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      setFiles(data?.files || []);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadOpenAIProviders = useCallback(async () => {
    setOpenAIProvidersLoading(true);
    try {
      const data = await providersApi.getOpenAIProviders();
      setOpenAIProviders(data || []);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError((prev) => prev || errorMessage);
    } finally {
      setOpenAIProvidersLoading(false);
    }
  }, [t]);

  const handleHeaderRefresh = useCallback(async () => {
    await Promise.all([
      loadConfig(),
      loadFiles(),
      loadOpenAIProviders(),
      refreshDisabledCredentialsSnapshot(true),
    ]);
  }, [loadConfig, loadFiles, loadOpenAIProviders, refreshDisabledCredentialsSnapshot]);

  const handleDeleteFailedCodexConfigs = useCallback(() => {
    if (deletingFailedConfigs) return;

    const systemLabel = t('quota_management.codex_query_system_label');
    const failedFileNames = Array.from(
      new Set(
        codexQueryFailedItems
          .map((item) => item.fileName)
          .filter((name) => name && name !== systemLabel)
      )
    );

    if (failedFileNames.length === 0) {
      showNotification(t('quota_management.codex_query_delete_none'), 'info');
      return;
    }

    showConfirmation({
      title: t('quota_management.codex_query_delete_failed'),
      message: t('quota_management.codex_query_delete_confirm', {
        count: failedFileNames.length,
      }),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        setDeletingFailedConfigs(true);
        try {
          const results = await Promise.allSettled(
            failedFileNames.map((name) => authFilesApi.deleteFile(name))
          );

          const deletedNames: string[] = [];
          let failedCount = 0;

          results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
              deletedNames.push(failedFileNames[index]);
            } else {
              failedCount += 1;
            }
          });

          if (deletedNames.length > 0) {
            const deletedSet = new Set(deletedNames);
            setFiles((prev) => prev.filter((file) => !deletedSet.has(file.name)));
            setCodexQuota((prev) => {
              const next = { ...prev };
              deletedNames.forEach((name) => {
                delete next[name];
              });
              return next;
            });
            removeFailedCodexItems(deletedNames);
          }

          if (deletedNames.length > 0 && failedCount === 0) {
            showNotification(
              t('quota_management.codex_query_delete_success', {
                count: deletedNames.length,
              }),
              'success'
            );
            return;
          }

          if (deletedNames.length > 0) {
            showNotification(
              t('quota_management.codex_query_delete_partial', {
                success: deletedNames.length,
                failed: failedCount,
              }),
              'warning'
            );
            return;
          }

          showNotification(t('quota_management.codex_query_delete_failed_notice'), 'error');
        } finally {
          setDeletingFailedConfigs(false);
        }
      },
    });
  }, [
    codexQueryFailedItems,
    deletingFailedConfigs,
    removeFailedCodexItems,
    setCodexQuota,
    showConfirmation,
    showNotification,
    t,
  ]);

  const getCredentialActionKey = useCallback((item: AuthFileItem) => {
    if (
      String(item.type ?? item.provider ?? '')
        .trim()
        .toLowerCase() === 'vercel'
    ) {
      return `openai:${String(item.providerName ?? '').trim()}:${String(item.apiKey ?? '').trim()}`;
    }
    return `auth-file:${item.name}`;
  }, []);

  const handleToggleQuotaCredential = useCallback(
    async (item: AuthFileItem) => {
      const providerType = String(item.type ?? item.provider ?? '')
        .trim()
        .toLowerCase();
      const target: DisableCredentialTarget =
        providerType === 'vercel'
          ? {
              kind: 'openai_api_key_entry',
              providerName: String(item.providerName ?? '').trim(),
              providerBaseUrl: String(item.providerBaseUrl ?? '').trim(),
              apiKey: String(item.apiKey ?? '').trim(),
              displayName: item.name,
              disabled: item.disabled === true,
            }
          : {
              kind: 'auth_file',
              name: item.name,
              authIndex: String(item['auth_index'] ?? item.authIndex ?? '').trim() || null,
              displayName: item.name,
              disabled: item.disabled === true,
            };

      const actionKey = getCredentialActionKey(item);
      setCredentialActionLoadingKey(actionKey);

      try {
        await setCredentialDisabledState(target, !target.disabled);
        if (target.kind === 'openai_api_key_entry') {
          await Promise.all([loadOpenAIProviders(), refreshDisabledCredentialsSnapshot(true)]);
        } else {
          await Promise.all([loadFiles(), refreshDisabledCredentialsSnapshot(true)]);
        }

        showNotification(
          target.disabled
            ? t('monitor.credential_restore_success', {
                defaultValue: '已恢复当前 key/凭证',
              })
            : t('monitor.credential_disable_success', {
                defaultValue: '已禁用当前 key/凭证',
              }),
          'success'
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        showNotification(message, 'error');
      } finally {
        setCredentialActionLoadingKey(null);
      }
    },
    [
      getCredentialActionKey,
      loadFiles,
      loadOpenAIProviders,
      refreshDisabledCredentialsSnapshot,
      setCredentialDisabledState,
      showNotification,
      t,
    ]
  );

  useHeaderRefresh(handleHeaderRefresh);

  const isRetryableVercelError = useCallback((error: unknown) => {
    const status = getStatusFromError(error);
    if (status !== undefined) {
      return false;
    }

    if (error && typeof error === 'object' && 'code' in error) {
      const code = String((error as { code?: unknown }).code ?? '')
        .trim()
        .toUpperCase();
      if (code === 'ECONNABORTED' || code === 'ERR_NETWORK' || code === 'ERR_CONNECTION_RESET') {
        return true;
      }
    }

    const message =
      error instanceof Error
        ? error.message.trim().toLowerCase()
        : String(error ?? '')
            .trim()
            .toLowerCase();

    return (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('connection reset') ||
      message.includes('failed to fetch')
    );
  }, []);

  const runVercelQuotaBatch = useCallback(
    async (targets: AuthFileItem[], options?: { collectRetryable?: boolean }) => {
      if (targets.length === 0) return [] as AuthFileItem[];

      setVercelQuota((prev) => {
        const next = { ...prev };
        targets.forEach((item) => {
          next[item.name] = VERCEL_CONFIG.buildLoadingState();
        });
        return next;
      });

      const retryableTargets: AuthFileItem[] = [];
      const results = await Promise.all(
        targets.map(async (item) => {
          try {
            const data = await VERCEL_CONFIG.fetchQuota(item, t);
            return { item, status: 'success' as const, data };
          } catch (error: unknown) {
            return {
              item,
              status: 'error' as const,
              error,
              retryable: options?.collectRetryable === true && isRetryableVercelError(error),
            };
          }
        })
      );

      setVercelQuota((prev) => {
        const next = { ...prev };
        results.forEach((result) => {
          if (result.status === 'success') {
            next[result.item.name] = VERCEL_CONFIG.buildSuccessState(result.data);
            return;
          }

          const message =
            result.error instanceof Error ? result.error.message : t('common.unknown_error');
          const errorStatus = getStatusFromError(result.error);
          next[result.item.name] = VERCEL_CONFIG.buildErrorState(message, errorStatus);

          if (result.retryable) {
            retryableTargets.push(result.item);
          }
        });
        return next;
      });

      return retryableTargets;
    },
    [isRetryableVercelError, setVercelQuota, t]
  );

  const handleVercelBulkQuery = useCallback(async () => {
    if (vercelBulkLoading) return;

    const start = performance.now();
    setVercelBulkLoading(true);

    const retryTargets: AuthFileItem[] = [];
    const firstRoundChunk = 60;
    for (let i = 0; i < vercelFiles.length; i += firstRoundChunk) {
      const sliced = vercelFiles.slice(i, i + firstRoundChunk);
      const batchRetryTargets = await runVercelQuotaBatch(sliced, { collectRetryable: true });
      retryTargets.push(...batchRetryTargets);
    }

    if (retryTargets.length > 0) {
      const secondRoundChunk = 10;
      for (let i = 0; i < retryTargets.length; i += secondRoundChunk) {
        const sliced = retryTargets.slice(i, i + secondRoundChunk);
        await runVercelQuotaBatch(sliced);
      }
    }

    setVercelBulkLoading(false);

    const duration = performance.now() - start;
    const seconds = (duration / 1000).toFixed(2);
    showNotification(
      t('quota_management.vercel_query_summary', {
        count: vercelFiles.length,
        duration: seconds,
      }),
      'success'
    );
  }, [runVercelQuotaBatch, vercelBulkLoading, vercelFiles, showNotification, t]);

  const handleDisableByCodexWeeklyLimit = useCallback(async () => {
    if (codexWeeklyLimitLoading) return;

    const { weeklyCandidates, keepNames, disableTargets, restoreTargets } = codexWeeklyLimitPlan;

    if (weeklyCandidates.length === 0) {
      showNotification(
        t('quota_management.codex_weekly_limit_missing', {
          defaultValue: '当前没有可用的 Codex 周限额数据，请先刷新额度',
        }),
        'warning'
      );
      return;
    }

    const changes = codexFiles.filter((file) => {
      if (disableTargets.has(file.name) && file.disabled !== true) return true;
      if (restoreTargets.has(file.name) && file.disabled === true) return true;
      return false;
    });

    if (changes.length === 0) {
      showNotification(
        t('quota_management.codex_weekly_limit_no_change', {
          defaultValue: '已按周限额规则整理，无需变更',
        }),
        'info'
      );
      return;
    }

    setCodexWeeklyLimitLoading(true);
    try {
      const results = await Promise.allSettled(
        changes.map((file) => authFilesApi.setStatus(file.name, disableTargets.has(file.name)))
      );

      let successCount = 0;
      let failedCount = 0;
      results.forEach((result) => {
        if (result.status === 'fulfilled') {
          successCount += 1;
        } else {
          failedCount += 1;
        }
      });

      await Promise.all([loadFiles(), refreshDisabledCredentialsSnapshot(true)]);

      if (failedCount === 0) {
        showNotification(
          t('quota_management.codex_weekly_limit_success', {
            defaultValue: '已按周限额自动整理凭证：保留 {{kept}} 个，禁用 {{disabled}} 个',
            kept: keepNames.size,
            disabled: disableTargets.size,
          }),
          'success'
        );
      } else {
        showNotification(
          t('quota_management.codex_weekly_limit_partial', {
            defaultValue: '周限额整理已完成：成功 {{success}} 个，失败 {{failed}} 个',
            success: successCount,
            failed: failedCount,
          }),
          'warning'
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(message, 'error');
    } finally {
      setCodexWeeklyLimitLoading(false);
    }
  }, [
    codexFiles,
    codexWeeklyLimitPlan,
    codexWeeklyLimitLoading,
    loadFiles,
    refreshDisabledCredentialsSnapshot,
    showNotification,
    t,
  ]);

  const markChannelQueriedAt = useCallback(
    <TState extends QuotaStateWithStatus>(
      channel: QuotaSnapshotChannel,
      quotaMap: QuotaStateMap<TState>
    ) => {
      const hasLoading = hasLoadingQuota(quotaMap);
      const hadLoading = channelLoadingRef.current[channel];

      if (hadLoading && !hasLoading && Object.keys(quotaMap).length > 0) {
        setQuotaQueryTimes((prev) => ({
          ...prev,
          [channel]: Date.now(),
        }));
      }

      channelLoadingRef.current[channel] = hasLoading;
    },
    []
  );

  useEffect(() => {
    markChannelQueriedAt('antigravity', antigravityQuota as QuotaStateMap<QuotaStateWithStatus>);
  }, [antigravityQuota, markChannelQueriedAt]);

  useEffect(() => {
    markChannelQueriedAt('claude', claudeQuota as QuotaStateMap<QuotaStateWithStatus>);
  }, [claudeQuota, markChannelQueriedAt]);

  useEffect(() => {
    markChannelQueriedAt('codex', codexQuota as QuotaStateMap<QuotaStateWithStatus>);
  }, [codexQuota, markChannelQueriedAt]);

  useEffect(() => {
    markChannelQueriedAt('vercel', vercelQuota as QuotaStateMap<QuotaStateWithStatus>);
  }, [vercelQuota, markChannelQueriedAt]);

  useEffect(() => {
    markChannelQueriedAt('gemini-cli', geminiCliQuota as QuotaStateMap<QuotaStateWithStatus>);
  }, [geminiCliQuota, markChannelQueriedAt]);

  useEffect(() => {
    markChannelQueriedAt('kimi', kimiQuota as QuotaStateMap<QuotaStateWithStatus>);
  }, [kimiQuota, markChannelQueriedAt]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const snapshot = await readQuotaSnapshot();
        if (cancelled || !snapshot) {
          return;
        }

        setAntigravityQuota(snapshot.channels.antigravity);
        setClaudeQuota(snapshot.channels.claude);
        setCodexQuota(snapshot.channels.codex);
        setVercelQuota(snapshot.channels.vercel);
        setGeminiCliQuota(snapshot.channels['gemini-cli']);
        setKimiQuota(snapshot.channels.kimi);
        setQuotaQueryTimes(snapshot.queryTimes);

        channelLoadingRef.current = {
          antigravity: hasLoadingQuota(
            snapshot.channels.antigravity as QuotaStateMap<QuotaStateWithStatus>
          ),
          claude: hasLoadingQuota(snapshot.channels.claude as QuotaStateMap<QuotaStateWithStatus>),
          codex: hasLoadingQuota(snapshot.channels.codex as QuotaStateMap<QuotaStateWithStatus>),
          vercel: hasLoadingQuota(snapshot.channels.vercel as QuotaStateMap<QuotaStateWithStatus>),
          'gemini-cli': hasLoadingQuota(
            snapshot.channels['gemini-cli'] as QuotaStateMap<QuotaStateWithStatus>
          ),
          kimi: hasLoadingQuota(snapshot.channels.kimi as QuotaStateMap<QuotaStateWithStatus>),
        };
      } catch (err) {
        console.warn('[Quota Snapshot] Failed to load snapshot:', err);
      } finally {
        if (!cancelled) {
          snapshotHydratedRef.current = true;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    setAntigravityQuota,
    setClaudeQuota,
    setCodexQuota,
    setGeminiCliQuota,
    setKimiQuota,
    setVercelQuota,
  ]);

  useEffect(() => {
    if (!snapshotHydratedRef.current) {
      return;
    }

    const timerId = window.setTimeout(() => {
      const state = useQuotaStore.getState();
      void writeQuotaSnapshot({
        queryTimes: quotaQueryTimes,
        channels: {
          antigravity: state.antigravityQuota,
          claude: state.claudeQuota,
          codex: state.codexQuota,
          vercel: state.vercelQuota,
          'gemini-cli': state.geminiCliQuota,
          kimi: state.kimiQuota,
        },
      });
    }, 200);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [quotaQueryTimes]);

  const formatQueryTimeText = useCallback(
    (channel: QuotaSnapshotChannel): string => {
      const timestamp = quotaQueryTimes[channel];
      if (!timestamp) {
        return t('quota_management.quota_query_time_empty', {
          defaultValue: '未查询',
        });
      }

      return formatDateTime(new Date(timestamp), i18n.language);
    },
    [i18n.language, quotaQueryTimes, t]
  );

  useEffect(() => {
    loadFiles();
    loadConfig();
    loadOpenAIProviders();
    void refreshDisabledCredentialsSnapshot();
  }, [loadFiles, loadConfig, loadOpenAIProviders, refreshDisabledCredentialsSnapshot]);

  const renderQuotaCredentialAction = useCallback(
    (item: AuthFileItem) => {
      const actionKey = getCredentialActionKey(item);
      const isLoading = credentialActionLoadingKey === actionKey;
      return (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleToggleQuotaCredential(item)}
          disabled={disableControls || isLoading}
          loading={isLoading}
        >
          {item.disabled
            ? t('monitor.credential_restore_button', { defaultValue: '恢复' })
            : t('monitor.logs.disable', { defaultValue: '禁用' })}
        </Button>
      );
    },
    [
      credentialActionLoadingKey,
      disableControls,
      getCredentialActionKey,
      handleToggleQuotaCredential,
      t,
    ]
  );

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{t('quota_management.title')}</h1>
        <p className={styles.description}>{t('quota_management.description')}</p>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      <QuotaSection
        config={CODEX_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        sortItems={sortCodexFilesByWeeklyReset}
        renderCardAction={renderQuotaCredentialAction}
        leadingHeaderActions={
          <div className={styles.headerSummaryText}>
            {t('quota_management.quota_query_time', {
              defaultValue: '查询时间',
            })}
            : {formatQueryTimeText('codex')}
          </div>
        }
        extraHeaderActions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleDisableByCodexWeeklyLimit()}
              disabled={disableControls || codexWeeklyLimitLoading}
              loading={codexWeeklyLimitLoading}
            >
              {t('quota_management.codex_weekly_limit_disable', {
                defaultValue: '按周限额禁用',
              })}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setCodexQueryModalOpen(true)}
              disabled={disableControls}
            >
              {t('quota_management.codex_query_all')}
            </Button>
          </>
        }
      />
      {vercelFiles.length > 0 ? (
        <QuotaSection
          config={VERCEL_CONFIG}
          files={vercelFiles}
          loading={openAIProvidersLoading}
          disabled={disableControls}
          renderCardAction={renderQuotaCredentialAction}
          leadingHeaderActions={
            <>
              {vercelTotalBalance !== null ? (
                <div className={styles.headerSummaryText}>
                  {t('vercel_quota.total_balance_label', {
                    defaultValue: '总余额',
                  })}
                  : {formatQuotaAmount(vercelTotalBalance)}
                </div>
              ) : null}
              <div className={styles.headerSummaryText}>
                {t('quota_management.quota_query_time', {
                  defaultValue: '查询时间',
                })}
                : {formatQueryTimeText('vercel')}
              </div>
            </>
          }
          extraHeaderActions={
            <Button
              variant="secondary"
              size="sm"
              onClick={handleVercelBulkQuery}
              disabled={disableControls || vercelBulkLoading}
              loading={vercelBulkLoading}
            >
              {t('quota_management.vercel_query_all')}
            </Button>
          }
        />
      ) : null}
      <QuotaSection
        config={GEMINI_CLI_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        renderCardAction={renderQuotaCredentialAction}
      />
      <QuotaSection
        config={CLAUDE_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        renderCardAction={renderQuotaCredentialAction}
      />
      <QuotaSection
        config={ANTIGRAVITY_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        renderCardAction={renderQuotaCredentialAction}
      />
      <QuotaSection
        config={KIMI_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        renderCardAction={renderQuotaCredentialAction}
      />

      <CodexBulkQueryModal
        open={codexQueryModalOpen}
        onClose={() => setCodexQueryModalOpen(false)}
        disabled={disableControls}
        deletingFailedConfigs={deletingFailedConfigs}
        queryState={{
          hasEverRun: codexHasEverRun,
          status: codexQueryStatus,
          total: codexQueryTotal,
          completed: codexQueryCompleted,
          errorCount: codexQueryErrorCount,
          failedItems: codexQueryFailedItems,
          lastStartedAt: codexQueryLastStartedAt,
          lastFinishedAt: codexQueryLastFinishedAt,
        }}
        onStart={startCodexBulkQuery}
        onStop={stopCodexBulkQuery}
        onDeleteFailed={handleDeleteFailedCodexConfigs}
      />
    </div>
  );
}
