import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useNotificationStore } from '@/stores';
import { useWebdavStore } from '../store/useWebdavStore';
import { useBackupActions } from '../hooks/useBackupActions';
import { formatFileSize } from '../utils';
import type { WebdavFileInfo, BackupScope } from '../types';
import { RestoreModal } from './RestoreModal';
import type { LocalBackupFileInfo } from '../localBackup';

export function RestoreCard() {
  const { t } = useTranslation();
  const { showConfirmation } = useNotificationStore();
  const {
    loadHistory,
    loadLocalHistory,
    restoreFromLocal,
    restore,
    restoreLocalBackup,
    downloadFile,
    downloadLocalFile,
    deleteRemote,
    deleteLocal,
  } = useBackupActions();

  const isRestoring = useWebdavStore((s) => s.isRestoring);
  const isLoadingHistory = useWebdavStore((s) => s.isLoadingHistory);
  const isHydrating = useWebdavStore((s) => s.isHydrating);
  const serverUrl = useWebdavStore((s) => s.connection.serverUrl);
  const lastBackupTime = useWebdavStore((s) => s.lastBackupTime);

  const [localFiles, setLocalFiles] = useState<LocalBackupFileInfo[]>([]);
  const [files, setFiles] = useState<WebdavFileInfo[]>([]);
  const [restoreLocalTarget, setRestoreLocalTarget] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [localResult, remoteResult] = await Promise.all([
      loadLocalHistory(),
      serverUrl ? loadHistory() : Promise.resolve([]),
    ]);
    setLocalFiles(localResult);
    setFiles(remoteResult);
  }, [loadHistory, loadLocalHistory, serverUrl]);

  // 初始加载 + 备份成功后自动刷新列表
  useEffect(() => {
    refresh();
  }, [refresh, lastBackupTime]);

  const handleRestore = useCallback(
    async (scope: BackupScope) => {
      if (restoreFile) {
        await restoreFromLocal(restoreFile, scope);
        setRestoreFile(null);
      } else if (restoreLocalTarget) {
        await restoreLocalBackup(restoreLocalTarget, scope);
        setRestoreLocalTarget(null);
      } else if (restoreTarget) {
        await restore(restoreTarget, scope);
      }
      setRestoreTarget(null);
    },
    [restoreFile, restore, restoreFromLocal, restoreLocalBackup, restoreLocalTarget, restoreTarget],
  );

  const handleFileSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setRestoreFile(file);
    }
    e.target.value = '';
  }, []);

  const handleDelete = useCallback(
    (filename: string, source: 'local' | 'cloud') => {
      showConfirmation({
        title: t('backup.delete_confirm_title'),
        message: t('backup.delete_confirm_message', { name: filename }),
        confirmText: t('common.delete'),
        variant: 'danger',
        onConfirm: async () => {
          if (source === 'local') {
            await deleteLocal(filename);
          } else {
            await deleteRemote(filename);
          }
          await refresh();
        },
      });
    },
    [showConfirmation, deleteLocal, deleteRemote, refresh, t],
  );

  return (
    <>
      <Card
        title={t('backup.restore_card_title')}
        subtitle={t('backup.restore_card_subtitle')}
        extra={
          <Button variant="ghost" size="sm" onClick={refresh} disabled={isHydrating || !serverUrl}>
            {t('common.refresh')}
          </Button>
        }
      >
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 从本地文件恢复 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              background: 'var(--bg-secondary)',
              borderRadius: 8,
              gap: 12,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 4 }}>
                {t('backup.restore_from_local')}
              </div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>
                {t('backup.restore_local_hint')}
              </div>
            </div>
            <Button
              variant="secondary"
              onClick={() => fileInputRef.current?.click()}
              disabled={isHydrating || isRestoring}
              loading={isRestoring && restoreFile !== null}
            >
              {t('backup.restore_local_btn')}
            </Button>
          </div>

          {isHydrating ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
              <LoadingSpinner />
            </div>
          ) : (
            <>
              {localFiles.length === 0 ? (
                <EmptyState title={t('backup.no_local_backups')} />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {localFiles.map((file) => (
                    <div
                      key={file.filename}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '8px 0',
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontWeight: 500, fontSize: 14 }}>{file.filename}</span>
                          <span
                            style={{
                              fontSize: 11,
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: 'rgba(16, 185, 129, 0.12)',
                              color: '#059669',
                              lineHeight: '18px',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t('backup.source_local')}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.6 }}>
                          {file.createdAt ? new Date(file.createdAt).toLocaleString() : ''}
                          {file.size > 0 ? ` · ${formatFileSize(file.size)}` : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRestoreLocalTarget(file.filename)}
                          disabled={isRestoring}
                        >
                          {t('backup.restore')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => downloadLocalFile(file.filename)}
                        >
                          {t('backup.download')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(file.filename, 'local')}
                        >
                          {t('common.delete')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!serverUrl ? (
                <div style={{ fontSize: 12, opacity: 0.5, textAlign: 'center', paddingTop: 8 }}>
                  {t('backup.restore_no_connection')}
                </div>
              ) : isLoadingHistory ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
                  <LoadingSpinner />
                </div>
              ) : files.length === 0 ? (
                <EmptyState title={t('backup.no_cloud_backups')} />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {files.map((file) => (
                    <div
                      key={file.href}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '8px 0',
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontWeight: 500, fontSize: 14 }}>{file.displayName}</span>
                          <span
                            style={{
                              fontSize: 11,
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: 'var(--accent-alpha, rgba(59,130,246,0.1))',
                              color: 'var(--accent, #3b82f6)',
                              lineHeight: '18px',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t('backup.source_cloud')}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.6 }}>
                          {file.lastModified ? new Date(file.lastModified).toLocaleString() : ''}
                          {file.contentLength > 0 ? ` · ${formatFileSize(file.contentLength)}` : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRestoreTarget(file.displayName)}
                          disabled={isRestoring}
                        >
                          {t('backup.restore')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => downloadFile(file.displayName)}
                        >
                          {t('backup.download')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(file.displayName, 'cloud')}
                        >
                          {t('common.delete')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={handleFileSelected}
      />

      <RestoreModal
        open={restoreLocalTarget !== null || restoreTarget !== null || restoreFile !== null}
        onClose={() => {
          setRestoreLocalTarget(null);
          setRestoreTarget(null);
          setRestoreFile(null);
        }}
        onRestore={handleRestore}
        loading={isRestoring}
        filename={restoreFile?.name ?? restoreLocalTarget ?? restoreTarget ?? ''}
      />
    </>
  );
}
