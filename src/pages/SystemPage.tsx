import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { IconGithub, IconBookOpen, IconExternalLink, IconCode } from '@/components/ui/icons';
import type { ApiError } from '@/types';
import {
  useAuthStore,
  useConfigStore,
  useNotificationStore,
  useModelsStore,
  useThemeStore,
} from '@/stores';
import { configApi, managementApi } from '@/services/api';
import { apiKeysApi } from '@/services/api/apiKeys';
import { collectConfiguredDisabledModelNames } from '@/utils/apiKeySettings';
import { classifyModels, mergeModelLists } from '@/utils/models';
import { STORAGE_KEY_AUTH } from '@/utils/constants';
import { INLINE_LOGO_JPEG } from '@/assets/logoInline';
import iconGemini from '@/assets/icons/gemini.svg';
import iconClaude from '@/assets/icons/claude.svg';
import iconOpenaiLight from '@/assets/icons/openai-light.svg';
import iconOpenaiDark from '@/assets/icons/openai-dark.svg';
import iconQwen from '@/assets/icons/qwen.svg';
import iconKimiLight from '@/assets/icons/kimi-light.svg';
import iconKimiDark from '@/assets/icons/kimi-dark.svg';
import iconGlm from '@/assets/icons/glm.svg';
import iconGrok from '@/assets/icons/grok.svg';
import iconDeepseek from '@/assets/icons/deepseek.svg';
import iconMinimax from '@/assets/icons/minimax.svg';
import styles from './SystemPage.module.scss';

const MODEL_CATEGORY_ICONS: Record<string, string | { light: string; dark: string }> = {
  gpt: { light: iconOpenaiLight, dark: iconOpenaiDark },
  claude: iconClaude,
  gemini: iconGemini,
  qwen: iconQwen,
  kimi: { light: iconKimiLight, dark: iconKimiDark },
  glm: iconGlm,
  grok: iconGrok,
  deepseek: iconDeepseek,
  minimax: iconMinimax,
};

type WebuiUpdateLog = {
  time: string;
  level: string;
  message: string;
};

type WebuiUpdateDialogState = {
  success: boolean;
  updated: boolean;
  message: string;
  filePath?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  logs: WebuiUpdateLog[];
  error?: string;
};

const normalizeWebuiUpdateLogs = (input: unknown): WebuiUpdateLog[] => {
  if (!Array.isArray(input)) return [];

  return input
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      return {
        time: typeof record.time === 'string' ? record.time : '',
        level: typeof record.level === 'string' ? record.level : 'info',
        message: typeof record.message === 'string' ? record.message : '',
      };
    })
    .filter((entry): entry is WebuiUpdateLog => Boolean(entry?.message));
};

const toWebuiUpdateDialogState = (input: unknown): WebuiUpdateDialogState | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const record = input as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message : '';
  if (!message) return null;

  return {
    success: Boolean(record.success),
    updated: Boolean(record.updated),
    message,
    filePath: typeof record.file_path === 'string' ? record.file_path : undefined,
    startedAt: typeof record.started_at === 'string' ? record.started_at : undefined,
    finishedAt: typeof record.finished_at === 'string' ? record.finished_at : undefined,
    durationMs: typeof record.duration_ms === 'number' ? record.duration_ms : undefined,
    logs: normalizeWebuiUpdateLogs(record.logs),
    error: typeof record.error === 'string' ? record.error : undefined,
  };
};

export function SystemPage() {
  const { t, i18n } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const auth = useAuthStore();
  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const clearCache = useConfigStore((state) => state.clearCache);
  const updateConfigValue = useConfigStore((state) => state.updateConfigValue);

  const models = useModelsStore((state) => state.models);
  const modelsLoading = useModelsStore((state) => state.loading);
  const modelsError = useModelsStore((state) => state.error);
  const fetchModelsFromStore = useModelsStore((state) => state.fetchModels);

  const [modelStatus, setModelStatus] = useState<{
    type: 'success' | 'warning' | 'error' | 'muted';
    message: string;
  }>();
  const [requestLogModalOpen, setRequestLogModalOpen] = useState(false);
  const [requestLogDraft, setRequestLogDraft] = useState(false);
  const [requestLogTouched, setRequestLogTouched] = useState(false);
  const [requestLogSaving, setRequestLogSaving] = useState(false);
  const [checkingWebuiUpdate, setCheckingWebuiUpdate] = useState(false);
  const [webuiUpdateModalOpen, setWebuiUpdateModalOpen] = useState(false);
  const [webuiUpdateDialog, setWebuiUpdateDialog] = useState<WebuiUpdateDialogState | null>(null);

  const apiKeysCache = useRef<string[]>([]);
  const versionTapCount = useRef(0);
  const versionTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const configuredDisabledModelNames = useMemo(() => {
    return collectConfiguredDisabledModelNames(config?.raw);
  }, [config?.raw]);

  const otherLabel = useMemo(
    () => (i18n.language?.toLowerCase().startsWith('zh') ? '其他' : 'Other'),
    [i18n.language]
  );
  const visibleModels = useMemo(
    () => mergeModelLists(models, configuredDisabledModelNames),
    [configuredDisabledModelNames, models]
  );
  const groupedModels = useMemo(
    () => classifyModels(visibleModels, { otherLabel }),
    [otherLabel, visibleModels]
  );
  const requestLogEnabled = config?.requestLog ?? false;
  const requestLogDirty = requestLogDraft !== requestLogEnabled;
  const canEditRequestLog = auth.connectionStatus === 'connected' && Boolean(config);

  const appVersion = __APP_VERSION__ || t('system_info.version_unknown');
  const apiVersion = auth.serverVersion || t('system_info.version_unknown');
  const appBuildTime = __APP_BUILD_TIME__ || '';
  const buildTime = appBuildTime
    ? new Date(appBuildTime).toLocaleString(i18n.language)
    : t('system_info.version_unknown');

  const getIconForCategory = (categoryId: string): string | null => {
    const iconEntry = MODEL_CATEGORY_ICONS[categoryId];
    if (!iconEntry) return null;
    if (typeof iconEntry === 'string') return iconEntry;
    return resolvedTheme === 'dark' ? iconEntry.dark : iconEntry.light;
  };

  const normalizeApiKeyList = (input: unknown): string[] => {
    if (!Array.isArray(input)) return [];
    const seen = new Set<string>();
    const keys: string[] = [];

    input.forEach((item) => {
      const record =
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : null;
      const value =
        typeof item === 'string'
          ? item
          : record
            ? (record['api-key'] ?? record['apiKey'] ?? record.key ?? record.Key)
            : '';
      const trimmed = String(value ?? '').trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      keys.push(trimmed);
    });

    return keys;
  };

  const resolveApiKeysForModels = useCallback(async () => {
    if (apiKeysCache.current.length) {
      return apiKeysCache.current;
    }

    const configKeys = normalizeApiKeyList(config?.apiKeys);
    if (configKeys.length) {
      apiKeysCache.current = configKeys;
      return configKeys;
    }

    try {
      const list = await apiKeysApi.list();
      const normalized = normalizeApiKeyList(list);
      if (normalized.length) {
        apiKeysCache.current = normalized;
      }
      return normalized;
    } catch (err) {
      console.warn('Auto loading API keys for models failed:', err);
      return [];
    }
  }, [config?.apiKeys]);

  const fetchModels = async ({ forceRefresh = false }: { forceRefresh?: boolean } = {}) => {
    if (auth.connectionStatus !== 'connected') {
      setModelStatus({
        type: 'warning',
        message: t('notification.connection_required'),
      });
      return;
    }

    if (!auth.apiBase) {
      showNotification(t('notification.connection_required'), 'warning');
      return;
    }

    if (forceRefresh) {
      apiKeysCache.current = [];
    }

    setModelStatus({ type: 'muted', message: t('system_info.models_loading') });
    try {
      const apiKeys = await resolveApiKeysForModels();
      const primaryKey = apiKeys[0];
      const list = await fetchModelsFromStore(auth.apiBase, primaryKey, forceRefresh);
      const hasModels = list.length > 0;
      setModelStatus({
        type: hasModels ? 'success' : 'warning',
        message: hasModels
          ? t('system_info.models_count', {
              count: mergeModelLists(list, configuredDisabledModelNames).length,
            })
          : t('system_info.models_empty'),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
      const suffix = message ? `: ${message}` : '';
      const text = `${t('system_info.models_error')}${suffix}`;
      setModelStatus({ type: 'error', message: text });
    }
  };

  const handleClearLoginStorage = () => {
    showConfirmation({
      title: t('system_info.clear_login_title', { defaultValue: 'Clear Login Storage' }),
      message: t('system_info.clear_login_confirm'),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: () => {
        auth.logout();
        if (typeof localStorage === 'undefined') return;
        const keysToRemove = [STORAGE_KEY_AUTH, 'isLoggedIn', 'apiBase', 'apiUrl', 'managementKey'];
        keysToRemove.forEach((key) => localStorage.removeItem(key));
        showNotification(t('notification.login_storage_cleared'), 'success');
      },
    });
  };

  const openRequestLogModal = useCallback(() => {
    setRequestLogTouched(false);
    setRequestLogDraft(requestLogEnabled);
    setRequestLogModalOpen(true);
  }, [requestLogEnabled]);

  const handleInfoVersionTap = useCallback(() => {
    versionTapCount.current += 1;
    if (versionTapTimer.current) {
      clearTimeout(versionTapTimer.current);
    }

    if (versionTapCount.current >= 7) {
      versionTapCount.current = 0;
      versionTapTimer.current = null;
      openRequestLogModal();
      return;
    }

    versionTapTimer.current = setTimeout(() => {
      versionTapCount.current = 0;
      versionTapTimer.current = null;
    }, 1500);
  }, [openRequestLogModal]);

  const handleRequestLogClose = useCallback(() => {
    setRequestLogModalOpen(false);
    setRequestLogTouched(false);
  }, []);

  const handleRequestLogSave = async () => {
    if (!canEditRequestLog) return;
    if (!requestLogDirty) {
      setRequestLogModalOpen(false);
      return;
    }

    const previous = requestLogEnabled;
    setRequestLogSaving(true);
    updateConfigValue('request-log', requestLogDraft);

    try {
      await configApi.updateRequestLog(requestLogDraft);
      clearCache('request-log');
      showNotification(t('notification.request_log_updated'), 'success');
      setRequestLogModalOpen(false);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      updateConfigValue('request-log', previous);
      showNotification(
        `${t('notification.update_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      setRequestLogSaving(false);
    }
  };

  const handleWebuiUpdate = useCallback(async () => {
    setCheckingWebuiUpdate(true);
    try {
      const response = await managementApi.updateWebui(true);
      const dialogState = toWebuiUpdateDialogState(response);
      if (dialogState) {
        setWebuiUpdateDialog(dialogState);
        setWebuiUpdateModalOpen(true);
      }
      showNotification(
        response.message,
        response.updated ? 'success' : response.success ? 'info' : 'warning'
      );
    } catch (error: unknown) {
      const apiError = error as ApiError;
      const dialogState =
        toWebuiUpdateDialogState(apiError?.details) ??
        toWebuiUpdateDialogState(apiError?.data) ?? {
          success: false,
          updated: false,
          message: t('system_info.webui_update_failed'),
          logs: [],
          error:
            error instanceof Error ? error.message : typeof error === 'string' ? error : undefined,
        };
      setWebuiUpdateDialog(dialogState);
      setWebuiUpdateModalOpen(true);

      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      const suffix = message ? `: ${message}` : '';
      showNotification(`${t('system_info.webui_update_failed')}${suffix}`, 'error');
    } finally {
      setCheckingWebuiUpdate(false);
    }
  }, [showNotification, t]);

  useEffect(() => {
    fetchConfig().catch(() => {
      // ignore
    });
  }, [fetchConfig]);

  useEffect(() => {
    if (requestLogModalOpen && !requestLogTouched) {
      setRequestLogDraft(requestLogEnabled);
    }
  }, [requestLogModalOpen, requestLogTouched, requestLogEnabled]);

  useEffect(() => {
    return () => {
      if (versionTapTimer.current) {
        clearTimeout(versionTapTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.connectionStatus, auth.apiBase]);

  return (
    <div className={styles.container}>
      <h1 className={styles.pageTitle}>{t('system_info.title')}</h1>
      <div className={styles.content}>
        <Card className={styles.aboutCard}>
          <div className={styles.aboutTopBar}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleWebuiUpdate()}
              loading={checkingWebuiUpdate}
            >
              {t('system_info.version_check_button')}
            </Button>
          </div>
          <div className={styles.aboutHeader}>
            <img src={INLINE_LOGO_JPEG} alt="CPAMC" className={styles.aboutLogo} />
            <div className={styles.aboutTitle}>{t('system_info.about_title')}</div>
          </div>

          <div className={styles.aboutInfoGrid}>
            <button
              type="button"
              className={`${styles.infoTile} ${styles.tapTile}`}
              onClick={handleInfoVersionTap}
            >
              <div className={styles.tileHeader}>
                <div className={styles.tileLabel}>{t('footer.version')}</div>
              </div>
              <div className={styles.tileValue}>{appVersion}</div>
            </button>

            <div className={styles.infoTile}>
              <div className={styles.tileHeader}>
                <div className={styles.tileLabel}>{t('footer.api_version')}</div>
              </div>
              <div className={styles.tileValue}>{apiVersion}</div>
            </div>

            <div className={styles.infoTile}>
              <div className={styles.tileLabel}>{t('system_info.webui_build_date')}</div>
              <div className={styles.tileValue}>{buildTime}</div>
            </div>

            <div className={styles.infoTile}>
              <div className={styles.tileLabel}>{t('connection.status')}</div>
              <div className={styles.tileValue}>{t(`common.${auth.connectionStatus}_status`)}</div>
              <div className={styles.tileSub}>{auth.apiBase || '-'}</div>
            </div>
          </div>
        </Card>

        <Card title={t('system_info.quick_links_title')}>
          <p className={styles.sectionDescription}>{t('system_info.quick_links_desc')}</p>
          <div className={styles.quickLinks}>
            <a
              href="https://github.com/router-for-me/CLIProxyAPI"
              target="_blank"
              rel="noopener noreferrer"
              className={styles.linkCard}
            >
              <div className={`${styles.linkIcon} ${styles.github}`}>
                <IconGithub size={22} />
              </div>
              <div className={styles.linkContent}>
                <div className={styles.linkTitle}>
                  {t('system_info.link_main_repo')}
                  <IconExternalLink size={14} />
                </div>
                <div className={styles.linkDesc}>{t('system_info.link_main_repo_desc')}</div>
              </div>
            </a>

            <a
              href="https://github.com/ouqiting/Cli-Proxy-API-Management-Center"
              target="_blank"
              rel="noopener noreferrer"
              className={styles.linkCard}
            >
              <div className={`${styles.linkIcon} ${styles.github}`}>
                <IconCode size={22} />
              </div>
              <div className={styles.linkContent}>
                <div className={styles.linkTitle}>
                  {t('system_info.link_webui_repo')}
                  <IconExternalLink size={14} />
                </div>
                <div className={styles.linkDesc}>{t('system_info.link_webui_repo_desc')}</div>
              </div>
            </a>

            <a
              href="https://help.router-for.me/"
              target="_blank"
              rel="noopener noreferrer"
              className={styles.linkCard}
            >
              <div className={`${styles.linkIcon} ${styles.docs}`}>
                <IconBookOpen size={22} />
              </div>
              <div className={styles.linkContent}>
                <div className={styles.linkTitle}>
                  {t('system_info.link_docs')}
                  <IconExternalLink size={14} />
                </div>
                <div className={styles.linkDesc}>{t('system_info.link_docs_desc')}</div>
              </div>
            </a>
          </div>
        </Card>

        <Card
          title={t('system_info.models_title')}
          extra={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fetchModels({ forceRefresh: true })}
              loading={modelsLoading}
            >
              {t('common.refresh')}
            </Button>
          }
        >
          <p className={styles.sectionDescription}>{t('system_info.models_desc')}</p>
          {modelStatus && (
            <div className={`status-badge ${modelStatus.type}`}>{modelStatus.message}</div>
          )}
          {modelsError && <div className="error-box">{modelsError}</div>}
          {modelsLoading ? (
            <div className="hint">{t('common.loading')}</div>
          ) : visibleModels.length === 0 ? (
            <div className="hint">{t('system_info.models_empty')}</div>
          ) : (
            <div className="item-list">
              {groupedModels.map((group) => {
                const iconSrc = getIconForCategory(group.id);
                return (
                  <div key={group.id} className="item-row">
                    <div className="item-meta">
                      <div className={styles.groupTitle}>
                        {iconSrc && <img src={iconSrc} alt="" className={styles.groupIcon} />}
                        <span className="item-title">{group.label}</span>
                      </div>
                      <div className="item-subtitle">
                        {t('system_info.models_count', { count: group.items.length })}
                      </div>
                    </div>
                    <div className={styles.modelTags}>
                      {group.items.map((model) => (
                        <span
                          key={`${model.name}-${model.alias ?? 'default'}`}
                          className={styles.modelTag}
                          title={model.description || ''}
                        >
                          <span className={styles.modelName}>{model.name}</span>
                          {model.alias && <span className={styles.modelAlias}>{model.alias}</span>}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card title={t('system_info.clear_login_title')}>
          <p className={styles.sectionDescription}>{t('system_info.clear_login_desc')}</p>
          <div className={styles.clearLoginActions}>
            <Button variant="danger" onClick={handleClearLoginStorage}>
              {t('system_info.clear_login_button')}
            </Button>
          </div>
        </Card>
      </div>

      <Modal
        open={webuiUpdateModalOpen}
        onClose={() => setWebuiUpdateModalOpen(false)}
        title={t('system_info.webui_update_title')}
        footer={
          <Button variant="primary" onClick={() => setWebuiUpdateModalOpen(false)}>
            {t('common.confirm')}
          </Button>
        }
        width={760}
      >
        {webuiUpdateDialog && (
          <div className={styles.updateModalBody}>
            <div
              className={`status-badge ${
                webuiUpdateDialog.success
                  ? webuiUpdateDialog.updated
                    ? 'success'
                    : 'muted'
                  : 'error'
              }`}
            >
              {webuiUpdateDialog.message}
            </div>

            <div className={styles.updateMetaGrid}>
              <div className={styles.updateMetaItem}>
                <span>{t('system_info.webui_update_started_at')}</span>
                <strong>
                  {webuiUpdateDialog.startedAt
                    ? new Date(webuiUpdateDialog.startedAt).toLocaleString(i18n.language)
                    : '-'}
                </strong>
              </div>
              <div className={styles.updateMetaItem}>
                <span>{t('system_info.webui_update_finished_at')}</span>
                <strong>
                  {webuiUpdateDialog.finishedAt
                    ? new Date(webuiUpdateDialog.finishedAt).toLocaleString(i18n.language)
                    : '-'}
                </strong>
              </div>
              <div className={styles.updateMetaItem}>
                <span>{t('system_info.webui_update_duration')}</span>
                <strong>
                  {typeof webuiUpdateDialog.durationMs === 'number'
                    ? `${webuiUpdateDialog.durationMs} ms`
                    : '-'}
                </strong>
              </div>
              <div className={styles.updateMetaItem}>
                <span>{t('system_info.webui_update_file_path')}</span>
                <strong title={webuiUpdateDialog.filePath}>{webuiUpdateDialog.filePath || '-'}</strong>
              </div>
            </div>

            {webuiUpdateDialog.error && (
              <div className="error-box">{webuiUpdateDialog.error}</div>
            )}

            <div className={styles.updateLogsSection}>
              <div className={styles.updateLogsTitle}>{t('system_info.webui_update_logs')}</div>
              {webuiUpdateDialog.logs.length === 0 ? (
                <div className="hint">{t('system_info.webui_update_logs_empty')}</div>
              ) : (
                <div className={styles.updateLogsList}>
                  {webuiUpdateDialog.logs.map((log, index) => (
                    <div key={`${log.time}-${log.message}-${index}`} className={styles.updateLogItem}>
                      <span className={styles.updateLogTime}>
                        {log.time ? new Date(log.time).toLocaleTimeString(i18n.language) : '--:--:--'}
                      </span>
                      <span className={styles.updateLogLevel}>{log.level}</span>
                      <span className={styles.updateLogMessage}>{log.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={requestLogModalOpen}
        onClose={handleRequestLogClose}
        title={t('basic_settings.request_log_title')}
        footer={
          <>
            <Button variant="secondary" onClick={handleRequestLogClose} disabled={requestLogSaving}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleRequestLogSave}
              loading={requestLogSaving}
              disabled={!canEditRequestLog || !requestLogDirty}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="request-log-modal">
          <div className="status-badge warning">{t('basic_settings.request_log_warning')}</div>
          <ToggleSwitch
            label={t('basic_settings.request_log_enable')}
            labelPosition="left"
            checked={requestLogDraft}
            disabled={!canEditRequestLog || requestLogSaving}
            onChange={(value) => {
              setRequestLogDraft(value);
              setRequestLogTouched(true);
            }}
          />
        </div>
      </Modal>
    </div>
  );
}
