import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import type { CodexBulkQueryState } from '@/types';
import styles from '@/pages/QuotaPage.module.scss';

interface CodexBulkQueryModalProps {
  open: boolean;
  onClose: () => void;
  disabled: boolean;
  queryState: CodexBulkQueryState;
  onStart: () => Promise<void> | void;
  onStop: () => void;
}

export function CodexBulkQueryModal({
  open,
  onClose,
  disabled,
  queryState,
  onStart,
  onStop,
}: CodexBulkQueryModalProps) {
  const { t } = useTranslation();

  const isRunning = queryState.status === 'running' || queryState.status === 'stopping';
  const progressLabel = useMemo(
    () =>
      t('quota_management.codex_query_progress', {
        completed: queryState.completed,
        total: queryState.total,
      }),
    [queryState.completed, queryState.total, t]
  );

  const footer = (
    <>
      <Button
        size="sm"
        onClick={() => void onStart()}
        disabled={disabled || isRunning}
      >
        {t('quota_management.codex_query_start')}
      </Button>
      <Button
        variant="danger"
        size="sm"
        onClick={onStop}
        disabled={disabled || queryState.status !== 'running'}
      >
        {t('quota_management.codex_query_stop')}
      </Button>
      <Button variant="secondary" size="sm" onClick={onClose}>
        {t('quota_management.codex_query_background')}
      </Button>
    </>
  );

  const renderContent = () => {
    if (!queryState.hasEverRun) {
      return <div className={styles.codexQueryBlank} />;
    }

    const showNoFilesState =
      queryState.status === 'completed' &&
      queryState.total === 0 &&
      queryState.failedItems.length === 0 &&
      queryState.errorCount === 0;

    return (
      <div className={styles.codexQueryPanel}>
        <div className={styles.codexQueryStats}>
          <span className={styles.codexQueryProgress}>{progressLabel}</span>
          <span className={styles.codexQueryErrorCount}>
            {t('quota_management.codex_query_error_count', {
              count: queryState.errorCount,
            })}
          </span>
        </div>

        {showNoFilesState ? (
          <div className={styles.codexQueryHint}>
            {t('quota_management.codex_query_no_files')}
          </div>
        ) : null}

        {!showNoFilesState &&
        !isRunning &&
        queryState.failedItems.length === 0 &&
        queryState.total > 0 ? (
          <div className={styles.codexQueryHint}>
            {t('quota_management.codex_query_no_errors')}
          </div>
        ) : null}

        {queryState.failedItems.length > 0 ? (
          <div className={styles.codexQueryResultList}>
            {queryState.failedItems.map((item, index) => (
              <div
                key={`${item.fileName}-${index}`}
                className={styles.codexQueryResultItem}
              >
                <div className={styles.codexQueryResultName}>{item.fileName}</div>
                <div className={styles.codexQueryResultMessage}>{item.message}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('quota_management.codex_query_modal_title')}
      footer={footer}
      width={720}
      className={styles.codexQueryModal}
    >
      {renderContent()}
    </Modal>
  );
}
