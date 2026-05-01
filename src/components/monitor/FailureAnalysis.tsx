import { useMemo, useState, useCallback, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { useDisableModel } from '@/hooks';
import { normalizeUsageSourceId } from '@/utils/usage';
import { resolveSourceDisplay, type SourceInfoMap } from '@/utils/sourceResolver';
import type { CredentialInfo } from '@/types/sourceInfo';
import { TimeRangeSelector, formatTimeRangeCaption, type TimeRange } from './TimeRangeSelector';
import { DisableModelModal } from './DisableModelModal';
import {
  formatTimestamp,
  getRateClassName,
  filterDataByTimeRange,
  getProviderDisplayParts,
  type DateRange,
} from '@/utils/monitor';
import type { UsageData } from '@/pages/MonitorPage';
import styles from '@/pages/MonitorPage.module.scss';

interface FailureAnalysisProps {
  data: UsageData | null;
  loading: boolean;
  providerMap: Record<string, string>;
  providerModels: Record<string, Set<string>>;
  sourceInfoMap: SourceInfoMap;
  authFileMap?: Map<string, CredentialInfo>;
}

interface ModelFailureStat {
  success: number;
  failure: number;
  total: number;
  successRate: number;
  recentRequests: { failed: boolean; timestamp: number }[];
  lastTimestamp: number;
}

interface FailureStat {
  source: string;
  authIndex: string;
  displayName: string;
  providerName: string | null;
  providerType: string;
  maskedKey: string;
  failedCount: number;
  lastFailTime: number;
  models: Record<string, ModelFailureStat>;
}

export function FailureAnalysis({
  data,
  loading,
  providerMap,
  providerModels,
  sourceInfoMap,
  authFileMap,
}: FailureAnalysisProps) {
  const { t } = useTranslation();
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null);
  const [filterChannel, setFilterChannel] = useState('');
  const [filterModel, setFilterModel] = useState('');
  const [timeRange, setTimeRange] = useState<TimeRange>(7);
  const [customRange, setCustomRange] = useState<DateRange | undefined>();

  const {
    disableState,
    disabling,
    isCredentialDisabled,
    canDisableCredential,
    handleDisableClick: onDisableClick,
    handleConfirmDisable,
    handleCancelDisable,
  } = useDisableModel({ providerMap, providerModels, sourceInfoMap });

  const handleTimeRangeChange = useCallback((range: TimeRange, custom?: DateRange) => {
    setTimeRange(range);
    if (custom) {
      setCustomRange(custom);
    }
  }, []);

  const timeFilteredData = useMemo(() => {
    return filterDataByTimeRange(data, timeRange, customRange);
  }, [data, timeRange, customRange]);

  const failureStats = useMemo(() => {
    if (!timeFilteredData?.apis) return [];

    const normalizeCache = new Map<string, string>();
    const credMap = authFileMap || new Map<string, CredentialInfo>();
    const getNormalized = (source: string) => {
      let result = normalizeCache.get(source);
      if (result === undefined) {
        result = normalizeUsageSourceId(source);
        normalizeCache.set(source, result);
      }
      return result;
    };

    const failedSources = new Set<string>();
    Object.values(timeFilteredData.apis).forEach((apiData) => {
      Object.values(apiData.models).forEach((modelData) => {
        modelData.details.forEach((detail) => {
          if (!detail.failed) return;
          const source = detail.source || 'unknown';
          const normalizedSource = getNormalized(source);
          const sourceInfo = resolveSourceDisplay(
            normalizedSource,
            detail.auth_index,
            sourceInfoMap,
            credMap
          );
          const { provider } = getProviderDisplayParts(source, providerMap);
          if (provider || (sourceInfo.displayName && sourceInfo.displayName !== normalizedSource)) {
            failedSources.add(source);
          }
        });
      });
    });

    const stats: Record<string, FailureStat> = {};

    Object.values(timeFilteredData.apis).forEach((apiData) => {
      Object.entries(apiData.models).forEach(([modelName, modelData]) => {
        modelData.details.forEach((detail) => {
          const source = detail.source || 'unknown';
          const authIndex = detail.auth_index ? String(detail.auth_index) : '';
          if (!failedSources.has(source)) return;

          const normalizedSource = getNormalized(source);
          const sourceInfo = resolveSourceDisplay(
            normalizedSource,
            detail.auth_index,
            sourceInfoMap,
            credMap
          );
          const { provider, masked } = getProviderDisplayParts(source, providerMap);
          const resolvedName =
            sourceInfo.displayName && sourceInfo.displayName !== normalizedSource
              ? sourceInfo.displayName
              : provider;
          const displayName = provider
            ? `${provider} (${masked})`
            : resolvedName
              ? `${resolvedName} (${masked})`
              : masked;
          const timestamp = detail.timestamp ? new Date(detail.timestamp).getTime() : 0;

          if (!stats[displayName]) {
            stats[displayName] = {
              source,
              authIndex,
              displayName,
              providerName: provider || resolvedName,
              providerType: sourceInfo.type || '',
              maskedKey: masked,
              failedCount: 0,
              lastFailTime: 0,
              models: {},
            };
          }

          if (!stats[displayName].authIndex && authIndex) {
            stats[displayName].authIndex = authIndex;
          }

          if (detail.failed) {
            stats[displayName].failedCount += 1;
            if (timestamp > stats[displayName].lastFailTime) {
              stats[displayName].lastFailTime = timestamp;
            }
          }

          if (!stats[displayName].models[modelName]) {
            stats[displayName].models[modelName] = {
              success: 0,
              failure: 0,
              total: 0,
              successRate: 0,
              recentRequests: [],
              lastTimestamp: 0,
            };
          }

          const modelStat = stats[displayName].models[modelName];
          modelStat.total += 1;
          if (detail.failed) {
            modelStat.failure += 1;
          } else {
            modelStat.success += 1;
          }
          modelStat.recentRequests.push({ failed: detail.failed, timestamp });
          if (timestamp > modelStat.lastTimestamp) {
            modelStat.lastTimestamp = timestamp;
          }
        });
      });
    });

    Object.values(stats).forEach((stat) => {
      Object.values(stat.models).forEach((model) => {
        model.successRate = model.total > 0 ? (model.success / model.total) * 100 : 0;
        model.recentRequests.sort((a, b) => a.timestamp - b.timestamp);
        model.recentRequests = model.recentRequests.slice(-12);
      });
    });

    return Object.values(stats)
      .filter((stat) => stat.failedCount > 0)
      .sort((a, b) => b.failedCount - a.failedCount)
      .slice(0, 10);
  }, [timeFilteredData, providerMap, sourceInfoMap, authFileMap]);

  const { channels, models } = useMemo(() => {
    const channelSet = new Set<string>();
    const modelSet = new Set<string>();

    failureStats.forEach((stat) => {
      channelSet.add(stat.displayName);
      Object.keys(stat.models).forEach((model) => modelSet.add(model));
    });

    return {
      channels: Array.from(channelSet).sort(),
      models: Array.from(modelSet).sort(),
    };
  }, [failureStats]);

  const filteredStats = useMemo(() => {
    return failureStats.filter((stat) => {
      if (filterChannel && stat.displayName !== filterChannel) return false;
      if (filterModel && !stat.models[filterModel]) return false;
      return true;
    });
  }, [failureStats, filterChannel, filterModel]);

  const toggleExpand = (displayName: string) => {
    setExpandedChannel(expandedChannel === displayName ? null : displayName);
  };

  const getTopFailedModels = (modelsMap: Record<string, ModelFailureStat>) =>
    Object.entries(modelsMap)
      .filter(([, stat]) => stat.failure > 0)
      .sort((a, b) => b[1].failure - a[1].failure)
      .slice(0, 2);

  const handleDisableClick = (
    source: string,
    authIndex: string,
    displayName: string,
    e: React.MouseEvent
  ) => {
    e.stopPropagation();
    onDisableClick({ source, authIndex, displayName });
  };

  return (
    <>
      <Card
        title={t('monitor.failure.title')}
        subtitle={
          <span>
            {formatTimeRangeCaption(timeRange, customRange, t)} 路 {t('monitor.failure.subtitle')}
            <span style={{ color: 'var(--text-tertiary)' }}> 路 {t('monitor.failure.click_hint')}</span>
          </span>
        }
        extra={
          <TimeRangeSelector
            value={timeRange}
            onChange={handleTimeRangeChange}
            customRange={customRange}
          />
        }
      >
        <div className={styles.logFilters}>
          <select
            className={styles.logSelect}
            value={filterChannel}
            onChange={(e) => setFilterChannel(e.target.value)}
          >
            <option value="">{t('monitor.channel.all_channels')}</option>
            {channels.map((channel) => (
              <option key={channel} value={channel}>{channel}</option>
            ))}
          </select>
          <select
            className={styles.logSelect}
            value={filterModel}
            onChange={(e) => setFilterModel(e.target.value)}
          >
            <option value="">{t('monitor.channel.all_models')}</option>
            {models.map((model) => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
        </div>

        <div className={styles.tableWrapper}>
          {loading ? (
            <div className={styles.emptyState}>{t('common.loading')}</div>
          ) : filteredStats.length === 0 ? (
            <div className={styles.emptyState}>{t('monitor.failure.no_failures')}</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t('monitor.failure.header_name')}</th>
                  <th>{t('monitor.failure.header_count')}</th>
                  <th>{t('monitor.failure.header_time')}</th>
                  <th>{t('monitor.failure.header_models')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredStats.map((stat) => {
                  const topModels = getTopFailedModels(stat.models);
                  const totalFailedModels = Object.values(stat.models).filter((m) => m.failure > 0).length;
                  const credentialDisabled = isCredentialDisabled({
                    source: stat.source,
                    authIndex: stat.authIndex,
                    displayName: stat.displayName,
                  });
                  const canToggle = canDisableCredential({
                    source: stat.source,
                    authIndex: stat.authIndex,
                    displayName: stat.displayName,
                  });

                  return (
                    <Fragment key={stat.displayName}>
                      <tr
                        className={styles.expandable}
                        onClick={() => toggleExpand(stat.displayName)}
                      >
                        <td>
                          {stat.providerName ? (
                            <>
                              <span className={styles.channelName}>{stat.providerName}</span>
                              <span className={styles.channelSecret}> ({stat.maskedKey})</span>
                            </>
                          ) : (
                            stat.maskedKey
                          )}
                        </td>
                        <td className={styles.kpiFailure}>{stat.failedCount.toLocaleString()}</td>
                        <td>{formatTimestamp(stat.lastFailTime)}</td>
                        <td>
                          {topModels.map(([model, modelStat]) => {
                            const percent = ((modelStat.failure / stat.failedCount) * 100).toFixed(0);
                            const shortModel = model.length > 16 ? model.slice(0, 13) + '...' : model;
                            return (
                              <span
                                key={model}
                                className={`${styles.failureModelTag} ${credentialDisabled ? styles.modelDisabled : ''}`}
                                title={`${model}: ${modelStat.failure} (${percent}%)${
                                  credentialDisabled ? ` - ${t('monitor.logs.disabled', { defaultValue: '已禁用' })}` : ''
                                }`}
                              >
                                {shortModel}
                              </span>
                            );
                          })}
                          {totalFailedModels > 2 && (
                            <span className={styles.moreModelsHint}>
                              +{totalFailedModels - 2}
                            </span>
                          )}
                        </td>
                      </tr>
                      {expandedChannel === stat.displayName && (
                        <tr key={`${stat.displayName}-detail`}>
                          <td colSpan={4} className={styles.expandDetail}>
                            <div className={styles.expandTableWrapper}>
                              <table className={styles.table}>
                                <thead>
                                  <tr>
                                    <th>{t('monitor.channel.model')}</th>
                                    <th>{t('monitor.channel.header_count')}</th>
                                    <th>{t('monitor.channel.header_rate')}</th>
                                    <th>{t('monitor.channel.success')}/{t('monitor.channel.failed')}</th>
                                    <th>{t('monitor.channel.header_recent')}</th>
                                    <th>{t('monitor.channel.header_time')}</th>
                                    <th>{t('monitor.logs.header_actions')}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {Object.entries(stat.models)
                                    .filter(([, m]) => m.failure > 0)
                                    .sort((a, b) => b[1].failure - a[1].failure)
                                    .map(([modelName, modelStat]) => (
                                      <tr
                                        key={modelName}
                                        className={credentialDisabled ? styles.modelDisabled : ''}
                                      >
                                        <td>{modelName}</td>
                                        <td>{modelStat.total.toLocaleString()}</td>
                                        <td className={getRateClassName(modelStat.successRate, styles)}>
                                          {modelStat.successRate.toFixed(1)}%
                                        </td>
                                        <td>
                                          <span className={styles.kpiSuccess}>{modelStat.success}</span>
                                          {' / '}
                                          <span className={styles.kpiFailure}>{modelStat.failure}</span>
                                        </td>
                                        <td>
                                          <div className={styles.statusBars}>
                                            {modelStat.recentRequests.map((req, i) => (
                                              <div
                                                key={i}
                                                className={`${styles.statusBar} ${req.failed ? styles.failure : styles.success}`}
                                              />
                                            ))}
                                          </div>
                                        </td>
                                        <td>{formatTimestamp(modelStat.lastTimestamp)}</td>
                                        <td>
                                          {canToggle ? (
                                            credentialDisabled ? (
                                              <span className={styles.disabledLabel}>
                                                {t('monitor.logs.disabled', { defaultValue: '已禁用' })}
                                              </span>
                                            ) : (
                                              <button
                                                className={`${styles.disableBtn} btn btn-secondary btn-sm`}
                                                onClick={(e) =>
                                                  handleDisableClick(
                                                    stat.source,
                                                    stat.authIndex,
                                                    stat.displayName,
                                                    e
                                                  )
                                                }
                                              >
                                                {t('monitor.logs.disable')}
                                              </button>
                                            )
                                          ) : (
                                            '-'
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      <DisableModelModal
        disableState={disableState}
        disabling={disabling}
        onConfirm={handleConfirmDisable}
        onCancel={handleCancelDisable}
      />
    </>
  );
}
