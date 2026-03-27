import { useMemo, useState, useCallback, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { useDisableModel } from '@/hooks';
import { normalizeUsageSourceId } from '@/utils/usage';
import { resolveSourceDisplay } from '@/utils/sourceResolver';
import type { SourceInfo, CredentialInfo } from '@/types/sourceInfo';
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

interface ChannelStatsProps {
  data: UsageData | null;
  loading: boolean;
  providerMap: Record<string, string>;
  providerModels: Record<string, Set<string>>;
  sourceInfoMap: Map<string, SourceInfo>;
  authFileMap?: Map<string, CredentialInfo>;
}

interface ModelStat {
  requests: number;
  success: number;
  failed: number;
  successRate: number;
  recentRequests: { failed: boolean; timestamp: number }[];
  lastTimestamp: number;
}

interface ChannelStat {
  source: string;
  authIndex: string;
  displayName: string;
  providerName: string | null;
  providerType: string;
  maskedKey: string;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  successRate: number;
  lastRequestTime: number;
  recentRequests: { failed: boolean; timestamp: number }[];
  models: Record<string, ModelStat>;
}

export function ChannelStats({
  data,
  loading,
  providerMap,
  providerModels,
  sourceInfoMap,
  authFileMap,
}: ChannelStatsProps) {
  const { t } = useTranslation();
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null);
  const [filterChannel, setFilterChannel] = useState('');
  const [filterModel, setFilterModel] = useState('');
  const [filterStatus, setFilterStatus] = useState<'' | 'success' | 'failed'>('');
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

  const channelStats = useMemo(() => {
    if (!timeFilteredData?.apis) return [];

    const stats: Record<string, ChannelStat> = {};
    const normalizeCache = new Map<string, string>();
    const credMap = authFileMap || new Map<string, CredentialInfo>();

    Object.values(timeFilteredData.apis).forEach((apiData) => {
      Object.entries(apiData.models).forEach(([modelName, modelData]) => {
        modelData.details.forEach((detail) => {
          const source = detail.source || 'unknown';
          const authIndex = detail.auth_index ? String(detail.auth_index) : '';

          let normalizedSource = normalizeCache.get(source);
          if (normalizedSource === undefined) {
            normalizedSource = normalizeUsageSourceId(source);
            normalizeCache.set(source, normalizedSource);
          }

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
          if (!resolvedName) return;

          const displayName = provider ? `${provider} (${masked})` : `${resolvedName} (${masked})`;
          const timestamp = detail.timestamp ? new Date(detail.timestamp).getTime() : 0;

          if (!stats[displayName]) {
            stats[displayName] = {
              source,
              authIndex,
              displayName,
              providerName: provider || resolvedName,
              providerType: sourceInfo.type || '',
              maskedKey: masked,
              totalRequests: 0,
              successRequests: 0,
              failedRequests: 0,
              successRate: 0,
              lastRequestTime: 0,
              recentRequests: [],
              models: {},
            };
          }

          if (!stats[displayName].authIndex && authIndex) {
            stats[displayName].authIndex = authIndex;
          }

          const channelStat = stats[displayName];
          channelStat.totalRequests += 1;
          if (detail.failed) {
            channelStat.failedRequests += 1;
          } else {
            channelStat.successRequests += 1;
          }

          if (timestamp > channelStat.lastRequestTime) {
            channelStat.lastRequestTime = timestamp;
          }

          channelStat.recentRequests.push({ failed: detail.failed, timestamp });

          if (!channelStat.models[modelName]) {
            channelStat.models[modelName] = {
              requests: 0,
              success: 0,
              failed: 0,
              successRate: 0,
              recentRequests: [],
              lastTimestamp: 0,
            };
          }

          const modelStat = channelStat.models[modelName];
          modelStat.requests += 1;
          if (detail.failed) {
            modelStat.failed += 1;
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
      stat.successRate =
        stat.totalRequests > 0 ? (stat.successRequests / stat.totalRequests) * 100 : 0;
      stat.recentRequests.sort((a, b) => a.timestamp - b.timestamp);
      stat.recentRequests = stat.recentRequests.slice(-12);

      Object.values(stat.models).forEach((model) => {
        model.successRate = model.requests > 0 ? (model.success / model.requests) * 100 : 0;
        model.recentRequests.sort((a, b) => a.timestamp - b.timestamp);
        model.recentRequests = model.recentRequests.slice(-12);
      });
    });

    return Object.values(stats)
      .filter((stat) => stat.totalRequests > 0)
      .sort((a, b) => b.totalRequests - a.totalRequests)
      .slice(0, 10);
  }, [timeFilteredData, providerMap, sourceInfoMap, authFileMap]);

  const { channels, models } = useMemo(() => {
    const channelSet = new Set<string>();
    const modelSet = new Set<string>();

    channelStats.forEach((stat) => {
      channelSet.add(stat.displayName);
      Object.keys(stat.models).forEach((model) => modelSet.add(model));
    });

    return {
      channels: Array.from(channelSet).sort(),
      models: Array.from(modelSet).sort(),
    };
  }, [channelStats]);

  const filteredStats = useMemo(() => {
    return channelStats.filter((stat) => {
      if (filterChannel && stat.displayName !== filterChannel) return false;
      if (filterModel && !stat.models[filterModel]) return false;
      if (filterStatus === 'success' && stat.failedRequests > 0) return false;
      if (filterStatus === 'failed' && stat.failedRequests === 0) return false;
      return true;
    });
  }, [channelStats, filterChannel, filterModel, filterStatus]);

  const toggleExpand = (displayName: string) => {
    setExpandedChannel(expandedChannel === displayName ? null : displayName);
  };

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
        title={t('monitor.channel.title')}
        subtitle={
          <span>
            {formatTimeRangeCaption(timeRange, customRange, t)} 路 {t('monitor.channel.subtitle')}
            <span style={{ color: 'var(--text-tertiary)' }}> 路 {t('monitor.channel.click_hint')}</span>
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
          <select
            className={styles.logSelect}
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as '' | 'success' | 'failed')}
          >
            <option value="">{t('monitor.channel.all_status')}</option>
            <option value="success">{t('monitor.channel.only_success')}</option>
            <option value="failed">{t('monitor.channel.only_failed')}</option>
          </select>
        </div>

        <div className={styles.tableWrapper}>
          {loading ? (
            <div className={styles.emptyState}>{t('common.loading')}</div>
          ) : filteredStats.length === 0 ? (
            <div className={styles.emptyState}>{t('monitor.no_data')}</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t('monitor.channel.header_name')}</th>
                  <th>{t('monitor.channel.header_count')}</th>
                  <th>{t('monitor.channel.header_rate')}</th>
                  <th>{t('monitor.channel.header_recent')}</th>
                  <th>{t('monitor.channel.header_time')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredStats.map((stat) => {
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
                        <td>{stat.totalRequests.toLocaleString()}</td>
                        <td className={getRateClassName(stat.successRate, styles)}>
                          {stat.successRate.toFixed(1)}%
                        </td>
                        <td>
                          <div className={styles.statusBars}>
                            {stat.recentRequests.map((req, i) => (
                              <div
                                key={i}
                                className={`${styles.statusBar} ${req.failed ? styles.failure : styles.success}`}
                              />
                            ))}
                          </div>
                        </td>
                        <td>{formatTimestamp(stat.lastRequestTime)}</td>
                      </tr>
                      {expandedChannel === stat.displayName && (
                        <tr key={`${stat.displayName}-detail`}>
                          <td colSpan={5} className={styles.expandDetail}>
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
                                    .sort((a, b) => b[1].requests - a[1].requests)
                                    .map(([modelName, modelStat]) => (
                                      <tr
                                        key={modelName}
                                        className={credentialDisabled ? styles.modelDisabled : ''}
                                      >
                                        <td>{modelName}</td>
                                        <td>{modelStat.requests.toLocaleString()}</td>
                                        <td className={getRateClassName(modelStat.successRate, styles)}>
                                          {modelStat.successRate.toFixed(1)}%
                                        </td>
                                        <td>
                                          <span className={styles.kpiSuccess}>{modelStat.success}</span>
                                          {' / '}
                                          <span className={styles.kpiFailure}>{modelStat.failed}</span>
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
