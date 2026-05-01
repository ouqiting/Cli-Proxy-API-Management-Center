import { create } from 'zustand';
import i18n from '@/i18n';
import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  CodexBulkQueryFailedItem,
  CodexBulkQueryState,
  CodexQuotaState,
} from '@/types';
import { authFilesApi } from '@/services/api/authFiles';
import { useNotificationStore } from './useNotificationStore';
import { useQuotaStore } from './useQuotaStore';
import {
  fetchCodexQuotaData,
  getStatusFromError,
  isCodexFile,
  resolveCodexBulkFailureMessage,
} from '@/utils/quota';

interface CodexBulkQueryStoreState extends CodexBulkQueryState {
  startQuery: () => Promise<void>;
  stopQuery: () => void;
}

const BATCH_SIZE = 10;
const RETRY_BATCH_SIZE = 4;

const initialState: CodexBulkQueryState = {
  hasEverRun: false,
  status: 'idle',
  total: 0,
  completed: 0,
  errorCount: 0,
  failedItems: [],
  lastStartedAt: null,
  lastFinishedAt: null,
};

let activeRunId = 0;
let activeAbortController: AbortController | null = null;

const t = i18n.t.bind(i18n) as TFunction;

const buildCodexLoadingState = (): CodexQuotaState => ({
  status: 'loading',
  windows: [],
});

const buildCodexSuccessState = (data: {
  planType: string | null;
  windows: CodexQuotaState['windows'];
}): CodexQuotaState => ({
  status: 'success',
  windows: data.windows,
  planType: data.planType,
});

const buildCodexErrorState = (message: string, errorStatus?: number): CodexQuotaState => ({
  status: 'error',
  windows: [],
  error: message,
  errorStatus,
});

const restoreCodexQuotaState = (fileName: string, previousState?: CodexQuotaState) => {
  useQuotaStore.getState().setCodexQuota((prev) => {
    const next = { ...prev };
    if (previousState) {
      next[fileName] = previousState;
    } else {
      delete next[fileName];
    }
    return next;
  });
};

const setCodexQuotaState = (fileName: string, nextState: CodexQuotaState) => {
  useQuotaStore.getState().setCodexQuota((prev) => ({
    ...prev,
    [fileName]: nextState,
  }));
};

const isAbortLikeError = (error: unknown): boolean => {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  if (error instanceof Error) {
    const maybeCode = (error as Error & { code?: string }).code;
    if (maybeCode === 'ERR_CANCELED' || maybeCode === 'ABORT_ERR') {
      return true;
    }

    const message = error.message.trim().toLowerCase();
    return message === 'canceled' || message.includes('abort');
  }

  if (typeof error === 'object' && error !== null && 'code' in error) {
    const maybeCode = String((error as { code?: unknown }).code ?? '');
    return maybeCode === 'ERR_CANCELED' || maybeCode === 'ABORT_ERR';
  }

  return false;
};

const finalizeCompletion = (
  set: (
    partial:
      | Partial<CodexBulkQueryStoreState>
      | ((state: CodexBulkQueryStoreState) => Partial<CodexBulkQueryStoreState>)
  ) => void,
  get: () => CodexBulkQueryStoreState,
  runId: number
) => {
  if (activeRunId !== runId) return;

  activeAbortController = null;
  set({
    status: 'completed',
    lastFinishedAt: Date.now(),
  });

  const state = get();
  if (state.total === 0) return;

  const notificationStore = useNotificationStore.getState();
  if (state.errorCount > 0) {
    notificationStore.showNotification(
      t('quota_management.codex_query_completed', { count: state.errorCount }),
      'warning'
    );
    return;
  }

  notificationStore.showNotification(
    t('quota_management.codex_query_completed_no_errors'),
    'success'
  );
};

const finalizeTermination = (
  set: (
    partial:
      | Partial<CodexBulkQueryStoreState>
      | ((state: CodexBulkQueryStoreState) => Partial<CodexBulkQueryStoreState>)
  ) => void,
  runId: number
) => {
  if (activeRunId !== runId) return;

  activeAbortController = null;
  set({
    status: 'terminated',
    lastFinishedAt: Date.now(),
  });
  useNotificationStore
    .getState()
    .showNotification(t('quota_management.codex_query_terminated'), 'info');
};

const runCodexQuotaBatch = async (
  targets: AuthFileItem[],
  runId: number,
  options?: { collectRetryable?: boolean }
) => {
  const retryableTargets: AuthFileItem[] = [];
  const failedResults: Array<{ fileName: string; message: string; errorStatus?: number }> = [];
  let completedCount = 0;

  if (targets.length === 0) {
    return { retryableTargets, failedResults, completedCount };
  }

  await Promise.allSettled(
    targets.map(async (file) => {
      const previousQuotaState = useQuotaStore.getState().codexQuota[file.name];

      setCodexQuotaState(file.name, buildCodexLoadingState());

      try {
        const data = await fetchCodexQuotaData(file, t, {
          signal: activeAbortController?.signal,
        });

        if (activeRunId !== runId) return;

        const failureMessage = resolveCodexBulkFailureMessage(data, t);
        if (failureMessage) {
          setCodexQuotaState(file.name, buildCodexErrorState(failureMessage));
          failedResults.push({
            fileName: file.name,
            message: failureMessage,
          });
          completedCount += 1;
          return;
        }

        setCodexQuotaState(file.name, buildCodexSuccessState(data));
        completedCount += 1;
      } catch (error: unknown) {
        if (activeRunId !== runId) return;

        if (activeAbortController?.signal.aborted && isAbortLikeError(error)) {
          restoreCodexQuotaState(file.name, previousQuotaState);
          return;
        }

        const message =
          error instanceof Error ? error.message : t('common.unknown_error');
        const errorStatus = getStatusFromError(error);

        setCodexQuotaState(file.name, buildCodexErrorState(message, errorStatus));
        failedResults.push({
          fileName: file.name,
          message,
          errorStatus,
        });
        completedCount += 1;

        if (options?.collectRetryable) {
          retryableTargets.push(file);
        }
      }
    })
  );

  return { retryableTargets, failedResults, completedCount };
};

export const useCodexBulkQueryStore = create<CodexBulkQueryStoreState>((set, get) => ({
  ...initialState,

  startQuery: async () => {
    const current = get();
    if (current.status === 'running' || current.status === 'stopping') {
      return;
    }

    const runId = activeRunId + 1;
    activeRunId = runId;
    activeAbortController = new AbortController();

    set({
      hasEverRun: true,
      status: 'running',
      total: 0,
      completed: 0,
      errorCount: 0,
      failedItems: [],
      lastStartedAt: Date.now(),
      lastFinishedAt: null,
    });

    try {
      const response = await authFilesApi.list();
      if (activeRunId !== runId) return;

      const targets = (response?.files || []).filter((file) => isCodexFile(file));

      set({ total: targets.length });

      if (targets.length === 0) {
        finalizeCompletion(set, get, runId);
        return;
      }

      const failedByFileName = new Map<string, CodexBulkQueryFailedItem>();
      let completedCount = 0;
      const retryTargets: AuthFileItem[] = [];

      for (let index = 0; index < targets.length; index += BATCH_SIZE) {
        if (activeRunId !== runId) return;
        if (activeAbortController?.signal.aborted) {
          finalizeTermination(set, runId);
          return;
        }

        const batch = targets.slice(index, index + BATCH_SIZE);
        const result = await runCodexQuotaBatch(batch, runId, { collectRetryable: true });
        result.retryableTargets.forEach((file) => retryTargets.push(file));
        result.failedResults.forEach((item) => failedByFileName.set(item.fileName, item));
        completedCount += result.completedCount;
        set({
          completed: completedCount,
          errorCount: failedByFileName.size,
          failedItems: Array.from(failedByFileName.values()),
        });
      }

      if (retryTargets.length > 0) {
        useNotificationStore
          .getState()
          .showNotification(
            t('quota_management.codex_query_retrying', { count: retryTargets.length }),
            'info'
          );
        for (let index = 0; index < retryTargets.length; index += RETRY_BATCH_SIZE) {
          if (activeRunId !== runId) return;
          if (activeAbortController?.signal.aborted) {
            finalizeTermination(set, runId);
            return;
          }

          const batch = retryTargets.slice(index, index + RETRY_BATCH_SIZE);
          const result = await runCodexQuotaBatch(batch, runId);
          result.failedResults.forEach((item) =>
            failedByFileName.set(item.fileName, {
              ...item,
              message: `${item.message}(已重试一次)`,
            })
          );
          batch.forEach((file) => {
            if (!result.failedResults.some((item) => item.fileName === file.name)) {
              failedByFileName.delete(file.name);
            }
          });
          set({
            errorCount: failedByFileName.size,
            failedItems: Array.from(failedByFileName.values()),
          });
        }
      }

      if (activeAbortController?.signal.aborted) {
        finalizeTermination(set, runId);
        return;
      }

      finalizeCompletion(set, get, runId);
    } catch (error: unknown) {
      if (activeRunId !== runId) return;

      if (activeAbortController?.signal.aborted && isAbortLikeError(error)) {
        finalizeTermination(set, runId);
        return;
      }

      const message = error instanceof Error ? error.message : t('common.unknown_error');
      set({
        status: 'completed',
        total: 1,
        completed: 1,
        errorCount: 1,
        failedItems: [
          {
            fileName: t('quota_management.codex_query_system_label'),
            message,
          },
        ],
        lastFinishedAt: Date.now(),
      });

      useNotificationStore.getState().showNotification(message, 'error');
    }
  },

  stopQuery: () => {
    const state = get();
    if (state.status !== 'running' || !activeAbortController) {
      return;
    }

    set({ status: 'stopping' });
    activeAbortController.abort();
  },
}));
