/**
 * Quota management page - coordinates the four quota sections.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useAuthStore } from '@/stores';
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

  const disableControls = connectionStatus !== 'connected';
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
      />
    </div>
  );
}
