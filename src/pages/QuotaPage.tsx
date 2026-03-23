/**
 * Quota management page - coordinates the four quota sections.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useAuthStore, useNotificationStore, useQuotaStore } from '@/stores';
import { useCodexBulkQueryStore } from '@/stores/useCodexBulkQueryStore';
import { authFilesApi, configFileApi } from '@/services/api';
import {
  QuotaSection,
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CodexBulkQueryModal,
  CODEX_CONFIG,
  GEMINI_CLI_CONFIG,
  KIMI_CONFIG
} from '@/components/quota';
import { Button } from '@/components/ui/Button';
import type { AuthFileItem } from '@/types';
import styles from './QuotaPage.module.scss';

export function QuotaPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [codexQueryModalOpen, setCodexQueryModalOpen] = useState(false);
  const [deletingFailedConfigs, setDeletingFailedConfigs] = useState(false);

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

  const handleHeaderRefresh = useCallback(async () => {
    await Promise.all([loadConfig(), loadFiles()]);
  }, [loadConfig, loadFiles]);

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
            useQuotaStore.getState().setCodexQuota((prev) => {
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
    showConfirmation,
    showNotification,
    t,
  ]);

  useHeaderRefresh(handleHeaderRefresh);

  useEffect(() => {
    loadFiles();
    loadConfig();
  }, [loadFiles, loadConfig]);

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{t('quota_management.title')}</h1>
        <p className={styles.description}>{t('quota_management.description')}</p>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      <QuotaSection
        config={CLAUDE_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
      />
      <QuotaSection
        config={ANTIGRAVITY_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
      />
      <QuotaSection
        config={CODEX_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        extraHeaderActions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCodexQueryModalOpen(true)}
            disabled={disableControls}
          >
            {t('quota_management.codex_query_all')}
          </Button>
        }
      />
      <QuotaSection
        config={GEMINI_CLI_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
      />
      <QuotaSection
        config={KIMI_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
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
