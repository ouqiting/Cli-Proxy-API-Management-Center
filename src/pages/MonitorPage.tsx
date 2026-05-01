import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  BarController,
  LineController,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Select } from '@/components/ui/Select';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useThemeStore, useConfigStore } from '@/stores';
import { usageApi, apiKeysApi, loadCredentialDisableSnapshot } from '@/services/api';
import { filterDataByApiFilter, filterDataByTimeRange } from '@/utils/monitor';
import {
  collectLoggingDisabledApiKeys,
  collectLoggingDisabledSourceIds,
} from '@/utils/apiKeySettings';
import { buildSourceInfoMap } from '@/utils/sourceResolver';
import { filterUsageByExcludedSources, normalizeAuthIndex } from '@/utils/usage';
import type { CredentialInfo } from '@/types/sourceInfo';
import { KpiCards } from '@/components/monitor/KpiCards';
import { ModelDistributionChart } from '@/components/monitor/ModelDistributionChart';
import { DailyTrendChart } from '@/components/monitor/DailyTrendChart';
import { HourlyModelChart } from '@/components/monitor/HourlyModelChart';
import { HourlyTokenChart } from '@/components/monitor/HourlyTokenChart';
import { ChannelStats } from '@/components/monitor/ChannelStats';
import { FailureAnalysis } from '@/components/monitor/FailureAnalysis';
import { RequestLogs } from '@/components/monitor/RequestLogs';
import styles from './MonitorPage.module.scss';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  BarController,
  LineController,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

type TimeRange = 1 | 7 | 14 | 30;

export interface UsageDetail {
  timestamp: string;
  failed: boolean;
  source: string;
  auth_index: string;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cached_tokens: number;
    total_tokens: number;
  };
  request_id?: string;
  method?: string;
  path?: string;
  status_code?: number;
  upstream_status_code?: number;
  error_stage?: string;
  error_code?: string;
  error_message?: string;
  upstream_error_message?: string;
  latency_ms?: number;
}

export interface UsageData {
  apis: Record<
    string,
    {
      models: Record<
        string,
        {
          details: UsageDetail[];
        }
      >;
    }
  >;
}

export function MonitorPage() {
  const { t } = useTranslation();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const rawConfig = useConfigStore((state) => state.config?.raw);
  const isDark = resolvedTheme === 'dark';
  const loggingDisabledSourceIds = useMemo(
    () => collectLoggingDisabledSourceIds(rawConfig),
    [rawConfig]
  );
  const loggingDisabledApiKeys = useMemo(
    () => collectLoggingDisabledApiKeys(rawConfig),
    [rawConfig]
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usageData, setUsageData] = useState<UsageData | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>(7);
  const [apiFilter, setApiFilter] = useState('');
  const [apiKeysOptions, setApiKeysOptions] = useState<Array<{ value: string; label: string }>>(
    []
  );
  const [providerMap, setProviderMap] = useState<Record<string, string>>({});
  const [providerModels, setProviderModels] = useState<Record<string, Set<string>>>({});
  const [providerTypeMap, setProviderTypeMap] = useState<Record<string, string>>({});
  const [sourceInfoMap, setSourceInfoMap] = useState<
    Map<string, import('@/types/sourceInfo').SourceInfo>
  >(new Map());
  const [authFileMap, setAuthFileMap] = useState<Map<string, CredentialInfo>>(new Map());

  const loadProviderMap = useCallback(async () => {
    try {
      const map: Record<string, string> = {};
      const modelsMap: Record<string, Set<string>> = {};
      const typeMap: Record<string, string> = {};
      const snapshot = await loadCredentialDisableSnapshot();
      const openaiProviders = snapshot.openaiProviders;
      const geminiKeys = snapshot.geminiKeys;
      const claudeConfigs = snapshot.claudeConfigs;
      const codexConfigs = snapshot.codexConfigs;
      const vertexConfigs = snapshot.vertexConfigs;
      const authFiles = snapshot.authFiles;

      openaiProviders.forEach((provider) => {
        const providerName = provider.headers?.['X-Provider'] || provider.name || 'unknown';
        const modelSet = new Set<string>();
        (provider.models || []).forEach((model) => {
          if (model.alias) modelSet.add(model.alias);
          if (model.name) modelSet.add(model.name);
        });

        (provider.apiKeyEntries || []).forEach((entry) => {
          if (!entry.apiKey) return;
          map[entry.apiKey] = providerName;
          modelsMap[entry.apiKey] = modelSet;
          typeMap[entry.apiKey] = 'OpenAI';
        });

        if (provider.name) {
          map[provider.name] = providerName;
          modelsMap[provider.name] = modelSet;
          typeMap[provider.name] = 'OpenAI';
        }
      });

      geminiKeys.forEach((config) => {
        if (!config.apiKey) return;
        const providerName = config.prefix?.trim() || 'Gemini';
        map[config.apiKey] = providerName;
        typeMap[config.apiKey] = 'Gemini';
      });

      claudeConfigs.forEach((config) => {
        if (!config.apiKey) return;
        const providerName = config.prefix?.trim() || 'Claude';
        map[config.apiKey] = providerName;
        typeMap[config.apiKey] = 'Claude';
        if (config.models && config.models.length > 0) {
          const modelSet = new Set<string>();
          config.models.forEach((model) => {
            if (model.alias) modelSet.add(model.alias);
            if (model.name) modelSet.add(model.name);
          });
          modelsMap[config.apiKey] = modelSet;
        }
      });

      codexConfigs.forEach((config) => {
        if (!config.apiKey) return;
        const providerName = config.prefix?.trim() || 'Codex';
        map[config.apiKey] = providerName;
        typeMap[config.apiKey] = 'Codex';
        if (config.models && config.models.length > 0) {
          const modelSet = new Set<string>();
          config.models.forEach((model) => {
            if (model.alias) modelSet.add(model.alias);
            if (model.name) modelSet.add(model.name);
          });
          modelsMap[config.apiKey] = modelSet;
        }
      });

      vertexConfigs.forEach((config) => {
        if (!config.apiKey) return;
        const providerName = config.prefix?.trim() || 'Vertex';
        map[config.apiKey] = providerName;
        typeMap[config.apiKey] = 'Vertex';
        if (config.models && config.models.length > 0) {
          const modelSet = new Set<string>();
          config.models.forEach((model) => {
            if (model.alias) modelSet.add(model.alias);
            if (model.name) modelSet.add(model.name);
          });
          modelsMap[config.apiKey] = modelSet;
        }
      });

      setProviderMap(map);
      setProviderModels(modelsMap);
      setProviderTypeMap(typeMap);
      setSourceInfoMap(
        buildSourceInfoMap({
          geminiApiKeys: geminiKeys,
          claudeApiKeys: claudeConfigs,
          codexApiKeys: codexConfigs,
          vertexApiKeys: vertexConfigs,
          openaiCompatibility: openaiProviders,
        })
      );

      const credMap = new Map<string, CredentialInfo>();
      authFiles.forEach((file) => {
        if (!file || typeof file !== 'object') return;
        const record = file as Record<string, unknown>;
        const credKey = normalizeAuthIndex(record['auth_index'] ?? record['authIndex']);
        if (!credKey) return;
        credMap.set(credKey, {
          name: String(record.name || credKey),
          type: String(record.type || record.provider || ''),
        });
      });
      setAuthFileMap(credMap);
    } catch (err) {
      console.warn('Monitor: Failed to load provider map:', err);
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    loadProviderMap();
    try {
      const [usageResponse, apiKeysResponse] = await Promise.allSettled([
        usageApi.getUsage(),
        apiKeysApi.list(),
      ]);

      if (apiKeysResponse.status === 'fulfilled') {
        const options = apiKeysResponse.value
          .map((key) => String(key ?? '').trim())
          .filter(Boolean)
          .map((key) => ({ value: key, label: key }));
        setApiKeysOptions(options);
        setApiFilter((current) =>
          current && !options.some((option) => option.value === current) ? '' : current
        );
      } else {
        setApiKeysOptions([]);
        setApiFilter('');
      }

      if (usageResponse.status !== 'fulfilled') {
        throw usageResponse.reason;
      }

      const response = usageResponse.value;
      const data = response?.usage ?? response;
      setUsageData(
        filterUsageByExcludedSources(
          data as UsageData,
          loggingDisabledSourceIds,
          loggingDisabledApiKeys
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      console.error('Monitor: Error loading data:', err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [loadProviderMap, loggingDisabledApiKeys, loggingDisabledSourceIds, t]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useHeaderRefresh(loadData);

  const displayUsageData = useMemo(() => {
    if (!usageData) return null;
    return filterUsageByExcludedSources(
      usageData,
      loggingDisabledSourceIds,
      loggingDisabledApiKeys
    );
  }, [loggingDisabledApiKeys, loggingDisabledSourceIds, usageData]);

  const apiFilteredData = useMemo(() => {
    return filterDataByApiFilter(displayUsageData, apiFilter);
  }, [displayUsageData, apiFilter]);

  const filteredData = useMemo(() => {
    return filterDataByTimeRange(apiFilteredData, timeRange);
  }, [apiFilteredData, timeRange]);

  const handleTimeRangeChange = (range: TimeRange) => {
    setTimeRange(range);
  };

  return (
    <div className={styles.container}>
      {loading && !usageData && (
        <div className={styles.loadingOverlay} aria-busy="true">
          <div className={styles.loadingOverlayContent}>
            <LoadingSpinner size={28} className={styles.loadingOverlaySpinner} />
            <span className={styles.loadingOverlayText}>{t('common.loading')}</span>
          </div>
        </div>
      )}

      <div className={styles.header}>
        <h1 className={styles.pageTitle}>{t('monitor.title')}</h1>
        <div className={styles.headerActions}>
          <Button variant="secondary" size="sm" onClick={loadData} disabled={loading}>
            {loading ? t('common.loading') : t('common.refresh')}
          </Button>
        </div>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      <div className={styles.filters}>
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>{t('monitor.time_range')}</span>
          <div className={styles.timeButtons}>
            {([1, 7, 14, 30] as TimeRange[]).map((range) => (
              <button
                key={range}
                className={`${styles.timeButton} ${timeRange === range ? styles.active : ''}`}
                onClick={() => handleTimeRangeChange(range)}
              >
                {range === 1 ? t('monitor.today') : t('monitor.last_n_days', { n: range })}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>{t('monitor.api_filter')}</span>
          <Select
            value={apiFilter}
            options={[
              { value: '', label: t('monitor.logs.all_apis', { defaultValue: '全部 API' }) },
              ...apiKeysOptions,
            ]}
            onChange={setApiFilter}
            ariaLabel={t('monitor.api_filter')}
            className={styles.monitorApiSelect}
          />
        </div>
      </div>

      <KpiCards data={filteredData} loading={loading} timeRange={timeRange} />

      <div className={styles.chartsGrid}>
        <ModelDistributionChart
          data={filteredData}
          loading={loading}
          isDark={isDark}
          timeRange={timeRange}
        />
        <DailyTrendChart
          data={filteredData}
          loading={loading}
          isDark={isDark}
          timeRange={timeRange}
        />
      </div>

      <HourlyModelChart data={apiFilteredData} loading={loading} isDark={isDark} />
      <HourlyTokenChart data={apiFilteredData} loading={loading} isDark={isDark} />

      <div className={styles.statsGrid}>
        <ChannelStats
          data={filteredData}
          loading={loading}
          providerMap={providerMap}
          providerModels={providerModels}
          sourceInfoMap={sourceInfoMap}
          authFileMap={authFileMap}
        />
        <FailureAnalysis
          data={filteredData}
          loading={loading}
          providerMap={providerMap}
          providerModels={providerModels}
          sourceInfoMap={sourceInfoMap}
          authFileMap={authFileMap}
        />
      </div>

      <RequestLogs
        data={filteredData}
        loading={loading}
        providerMap={providerMap}
        providerTypeMap={providerTypeMap}
        sourceInfoMap={sourceInfoMap}
        authFileMap={authFileMap}
        apiFilter={apiFilter}
      />
    </div>
  );
}
