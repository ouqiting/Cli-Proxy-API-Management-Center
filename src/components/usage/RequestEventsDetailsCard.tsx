import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useConfigStore } from '@/stores';
import { authFilesApi } from '@/services/api/authFiles';
import { logsApi, type RequestLogDetailResponse } from '@/services/api/logs';
import type { ApiError } from '@/types';
import type { GeminiKeyConfig, ProviderKeyConfig, OpenAIProviderConfig } from '@/types';
import type { AuthFileItem } from '@/types/authFile';
import type { CredentialInfo } from '@/types/sourceInfo';
import {
  collectLoggingDisabledApiKeys,
  collectLoggingDisabledSourceIds,
} from '@/utils/apiKeySettings';
import { buildSourceInfoMap, resolveSourceDisplay } from '@/utils/sourceResolver';
import { parseTimestampMs } from '@/utils/timestamp';
import {
  collectUsageDetails,
  extractLatencyMs,
  extractTotalTokens,
  normalizeAuthIndex,
  normalizeUsageSourceId,
  formatDurationMs,
  LATENCY_SOURCE_FIELD,
  type UsageThinking,
} from '@/utils/usage';
import { downloadBlob } from '@/utils/download';
import styles from '@/pages/UsagePage.module.scss';

const ALL_FILTER = '__all__';
const MAX_RENDERED_EVENTS = 500;

type RequestEventRow = {
  id: string;
  timestamp: string;
  timestampMs: number;
  timestampLabel: string;
  apiKey: string;
  model: string;
  sourceKey: string;
  sourceRaw: string;
  source: string;
  sourceType: string;
  authIndex: string;
  failed: boolean;
  requestId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  upstreamStatusCode?: number;
  errorStage?: string;
  errorCode?: string;
  errorMessage?: string;
  upstreamErrorMessage?: string;
  latencyMs: number | null;
  thinking: UsageThinking | null;
  thinkingLabel: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
};

const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err !== 'object' || err === null || !('message' in err)) return '';

  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
};

const stringifyData = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export interface RequestEventsDetailsCardProps {
  usage: unknown;
  loading: boolean;
  geminiKeys: GeminiKeyConfig[];
  claudeConfigs: ProviderKeyConfig[];
  codexConfigs: ProviderKeyConfig[];
  vertexConfigs: ProviderKeyConfig[];
  openaiProviders: OpenAIProviderConfig[];
}

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
};

const toOptionalNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const getDisplayStatusCode = (statusCode?: number, upstreamStatusCode?: number): number | undefined =>
  upstreamStatusCode ?? statusCode;

const normalizeThinkingText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const formatThinkingLabel = (thinking: UsageThinking | null): string => {
  if (!thinking) return '-';

  const intensity = normalizeThinkingText(thinking.intensity);
  const level = normalizeThinkingText(thinking.level);
  const mode = normalizeThinkingText(thinking.mode);
  const budget =
    typeof thinking.budget === 'number' && Number.isFinite(thinking.budget)
      ? thinking.budget
      : null;
  const label = intensity || level || (budget !== null ? String(budget) : mode);
  const budgetLabel = budget !== null ? budget.toLocaleString() : null;

  if (!label) return '-';
  if (budgetLabel !== null && label === String(budget)) {
    return budgetLabel;
  }
  if (mode === 'budget' && budget !== null && budget > 0) {
    return `${label} (${budgetLabel})`;
  }
  if (budget === -1 && label !== 'auto') {
    return `${label} (-1)`;
  }
  return label;
};

const encodeCsv = (value: string | number): string => {
  const text = String(value ?? '');
  const trimmedLeft = text.replace(/^\s+/, '');
  const safeText = trimmedLeft && /^[=+\-@]/.test(trimmedLeft) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
};

export function RequestEventsDetailsCard({
  usage,
  loading,
  geminiKeys,
  claudeConfigs,
  codexConfigs,
  vertexConfigs,
  openaiProviders,
}: RequestEventsDetailsCardProps) {
  const { t, i18n } = useTranslation();
  const rawConfig = useConfigStore((state) => state.config?.raw);
  const loggingDisabledApiKeys = useMemo(
    () => collectLoggingDisabledApiKeys(rawConfig),
    [rawConfig]
  );
  const loggingDisabledSourceIds = useMemo(
    () => collectLoggingDisabledSourceIds(rawConfig),
    [rawConfig]
  );
  const latencyHint = t('usage_stats.latency_unit_hint', {
    field: LATENCY_SOURCE_FIELD,
    unit: t('usage_stats.duration_unit_ms'),
  });

  const [modelFilter, setModelFilter] = useState(ALL_FILTER);
  const [sourceFilter, setSourceFilter] = useState(ALL_FILTER);
  const [authIndexFilter, setAuthIndexFilter] = useState(ALL_FILTER);
  const [authFileMap, setAuthFileMap] = useState<Map<string, CredentialInfo>>(new Map());
  const [detailRow, setDetailRow] = useState<RequestEventRow | null>(null);
  const [detailData, setDetailData] = useState<RequestLogDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  useEffect(() => {
    let cancelled = false;
    authFilesApi
      .list()
      .then((res) => {
        if (cancelled) return;
        const files = Array.isArray(res) ? res : (res as { files?: AuthFileItem[] })?.files;
        if (!Array.isArray(files)) return;
        const map = new Map<string, CredentialInfo>();
        files.forEach((file) => {
          const key = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
          if (!key) return;
          map.set(key, {
            name: file.name || key,
            type: (file.type || file.provider || '').toString(),
          });
        });
        setAuthFileMap(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceInfoMap = useMemo(
    () =>
      buildSourceInfoMap({
        geminiApiKeys: geminiKeys,
        claudeApiKeys: claudeConfigs,
        codexApiKeys: codexConfigs,
        vertexApiKeys: vertexConfigs,
        openaiCompatibility: openaiProviders,
      }),
    [claudeConfigs, codexConfigs, geminiKeys, openaiProviders, vertexConfigs]
  );

  const rows = useMemo<RequestEventRow[]>(() => {
    const details = collectUsageDetails(usage);

    const baseRows = details.map((detail, index) => {
      const timestamp = detail.timestamp;
      const timestampMs =
        typeof detail.__timestampMs === 'number' && detail.__timestampMs > 0
          ? detail.__timestampMs
          : parseTimestampMs(timestamp);
      const date = Number.isNaN(timestampMs) ? null : new Date(timestampMs);
      const sourceRaw = String(detail.source ?? '').trim();
      const authIndexRaw = detail.auth_index as unknown;
      const authIndex =
        authIndexRaw === null || authIndexRaw === undefined || authIndexRaw === ''
          ? '-'
          : String(authIndexRaw);
      const sourceInfo = resolveSourceDisplay(sourceRaw, authIndexRaw, sourceInfoMap, authFileMap);
      const source = sourceInfo.displayName;
      const sourceKey = sourceInfo.identityKey ?? `source:${sourceRaw || source}`;
      const sourceType = sourceInfo.type;
      const apiKey = String(detail.__apiName ?? '').trim();
      const model = String(detail.__modelName ?? '').trim() || '-';
      const inputTokens = Math.max(toNumber(detail.tokens?.input_tokens), 0);
      const outputTokens = Math.max(toNumber(detail.tokens?.output_tokens), 0);
      const reasoningTokens = Math.max(toNumber(detail.tokens?.reasoning_tokens), 0);
      const cachedTokens = Math.max(
        Math.max(toNumber(detail.tokens?.cached_tokens), 0),
        Math.max(toNumber(detail.tokens?.cache_tokens), 0)
      );
      const totalTokens = Math.max(
        toNumber(detail.tokens?.total_tokens),
        extractTotalTokens(detail)
      );
      const latencyMs = extractLatencyMs(detail);
      const thinking = detail.thinking ?? null;
      const thinkingLabel = formatThinkingLabel(thinking);

      return {
        id: `${timestamp}-${model}-${sourceKey}-${authIndex}-${index}`,
        timestamp,
        timestampMs: Number.isNaN(timestampMs) ? 0 : timestampMs,
        timestampLabel: date ? date.toLocaleString(i18n.language) : timestamp || '-',
        apiKey,
        model,
        sourceKey,
        sourceRaw: sourceRaw || '-',
        source,
        sourceType,
        authIndex,
        failed: detail.failed === true,
        requestId: detail.request_id,
        method: detail.method,
        path: detail.path,
        statusCode: toOptionalNumber(detail.status_code),
        upstreamStatusCode: toOptionalNumber(detail.upstream_status_code),
        errorStage: detail.error_stage,
        errorCode: detail.error_code,
        errorMessage: detail.error_message,
        upstreamErrorMessage: detail.upstream_error_message,
        latencyMs,
        thinking,
        thinkingLabel,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedTokens,
        totalTokens,
      };
    });

    const sourceLabelKeyMap = new Map<string, Set<string>>();
    baseRows.forEach((row) => {
      const keys = sourceLabelKeyMap.get(row.source) ?? new Set<string>();
      keys.add(row.sourceKey);
      sourceLabelKeyMap.set(row.source, keys);
    });

    const buildDisambiguatedSourceLabel = (row: RequestEventRow) => {
      const labelKeyCount = sourceLabelKeyMap.get(row.source)?.size ?? 0;
      if (labelKeyCount <= 1) {
        return row.source;
      }

      if (row.authIndex !== '-') {
        return `${row.source} · ${row.authIndex}`;
      }

      if (row.sourceRaw !== '-' && row.sourceRaw !== row.source) {
        return `${row.source} · ${row.sourceRaw}`;
      }

      if (row.sourceType) {
        return `${row.source} · ${row.sourceType}`;
      }

      return `${row.source} · ${row.sourceKey}`;
    };

    return baseRows
      .map((row) => ({
        ...row,
        source: buildDisambiguatedSourceLabel(row),
      }))
      .filter((row) => {
        const normalizedSource = normalizeUsageSourceId(row.sourceRaw);
        return !(
          row.failed !== true &&
          (loggingDisabledApiKeys.has(row.apiKey) ||
            Boolean(normalizedSource && loggingDisabledSourceIds.has(normalizedSource)))
        );
      })
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }, [
    authFileMap,
    i18n.language,
    loggingDisabledApiKeys,
    loggingDisabledSourceIds,
    sourceInfoMap,
    usage,
  ]);

  const hasLatencyData = useMemo(() => rows.some((row) => row.latencyMs !== null), [rows]);

  const modelOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(rows.map((row) => row.model))).map((model) => ({
        value: model,
        label: model,
      })),
    ],
    [rows, t]
  );

  const sourceOptions = useMemo(() => {
    const optionMap = new Map<string, string>();
    rows.forEach((row) => {
      if (!optionMap.has(row.sourceKey)) {
        optionMap.set(row.sourceKey, row.source);
      }
    });

    return [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(optionMap.entries()).map(([value, label]) => ({
        value,
        label,
      })),
    ];
  }, [rows, t]);

  const authIndexOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(rows.map((row) => row.authIndex))).map((authIndex) => ({
        value: authIndex,
        label: authIndex,
      })),
    ],
    [rows, t]
  );

  const modelOptionSet = useMemo(
    () => new Set(modelOptions.map((option) => option.value)),
    [modelOptions]
  );
  const sourceOptionSet = useMemo(
    () => new Set(sourceOptions.map((option) => option.value)),
    [sourceOptions]
  );
  const authIndexOptionSet = useMemo(
    () => new Set(authIndexOptions.map((option) => option.value)),
    [authIndexOptions]
  );

  const effectiveModelFilter = modelOptionSet.has(modelFilter) ? modelFilter : ALL_FILTER;
  const effectiveSourceFilter = sourceOptionSet.has(sourceFilter) ? sourceFilter : ALL_FILTER;
  const effectiveAuthIndexFilter = authIndexOptionSet.has(authIndexFilter)
    ? authIndexFilter
    : ALL_FILTER;

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        const modelMatched =
          effectiveModelFilter === ALL_FILTER || row.model === effectiveModelFilter;
        const sourceMatched =
          effectiveSourceFilter === ALL_FILTER || row.sourceKey === effectiveSourceFilter;
        const authIndexMatched =
          effectiveAuthIndexFilter === ALL_FILTER || row.authIndex === effectiveAuthIndexFilter;
        return modelMatched && sourceMatched && authIndexMatched;
      }),
    [effectiveAuthIndexFilter, effectiveModelFilter, effectiveSourceFilter, rows]
  );

  const renderedRows = useMemo(() => filteredRows.slice(0, MAX_RENDERED_EVENTS), [filteredRows]);

  const hasActiveFilters =
    effectiveModelFilter !== ALL_FILTER ||
    effectiveSourceFilter !== ALL_FILTER ||
    effectiveAuthIndexFilter !== ALL_FILTER;

  const handleClearFilters = () => {
    setModelFilter(ALL_FILTER);
    setSourceFilter(ALL_FILTER);
    setAuthIndexFilter(ALL_FILTER);
  };

  const handleOpenDetail = async (row: RequestEventRow) => {
    setDetailRow(row);
    setDetailData(null);
    setDetailError('');

    if (!row.requestId) {
      return;
    }

    setDetailLoading(true);
    try {
      const response = await logsApi.fetchRequestLogDetail(row.requestId);
      setDetailData(response);
    } catch (err: unknown) {
      if ((err as ApiError).status !== 404) {
        setDetailError(getErrorMessage(err) || t('usage_stats.request_events_detail_error'));
      }
    } finally {
      setDetailLoading(false);
    }
  };

  const handleExportCsv = () => {
    if (!filteredRows.length) return;

    const csvHeader = [
      'timestamp',
      'model',
      'source',
      'source_raw',
      'auth_index',
      'request_id',
      'method',
      'path',
      'result',
      'status_code',
      'upstream_status_code',
      'error_stage',
      'error_code',
      'error_message',
      'upstream_error_message',
      ...(hasLatencyData ? ['latency_ms'] : []),
      'thinking_intensity',
      'thinking_mode',
      'thinking_level',
      'thinking_budget',
      'input_tokens',
      'output_tokens',
      'reasoning_tokens',
      'cached_tokens',
      'total_tokens',
    ];

    const csvRows = filteredRows.map((row) =>
      [
        row.timestamp,
        row.model,
        row.source,
        row.sourceRaw,
        row.authIndex,
        row.requestId || '',
        row.method || '',
        row.path || '',
        row.failed ? 'failed' : 'success',
        row.statusCode ?? '',
        row.upstreamStatusCode ?? '',
        row.errorStage || '',
        row.errorCode || '',
        row.errorMessage || '',
        row.upstreamErrorMessage || '',
        ...(hasLatencyData ? [row.latencyMs ?? ''] : []),
        row.thinking?.intensity ?? '',
        row.thinking?.mode ?? '',
        row.thinking?.level ?? '',
        row.thinking?.budget ?? '',
        row.inputTokens,
        row.outputTokens,
        row.reasoningTokens,
        row.cachedTokens,
        row.totalTokens,
      ]
        .map((value) => encodeCsv(value))
        .join(',')
    );

    const content = [csvHeader.join(','), ...csvRows].join('\n');
    const fileTime = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob({
      filename: `usage-events-${fileTime}.csv`,
      blob: new Blob([content], { type: 'text/csv;charset=utf-8' }),
    });
  };

  const handleExportJson = () => {
    if (!filteredRows.length) return;

    const payload = filteredRows.map((row) => ({
      timestamp: row.timestamp,
      model: row.model,
      source: row.source,
      source_raw: row.sourceRaw,
      auth_index: row.authIndex,
      request_id: row.requestId,
      method: row.method,
      path: row.path,
      failed: row.failed,
      status_code: row.statusCode,
      upstream_status_code: row.upstreamStatusCode,
      error_stage: row.errorStage,
      error_code: row.errorCode,
      error_message: row.errorMessage,
      upstream_error_message: row.upstreamErrorMessage,
      ...(hasLatencyData && row.latencyMs !== null ? { latency_ms: row.latencyMs } : {}),
      ...(row.thinking ? { thinking: row.thinking } : {}),
      tokens: {
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        reasoning_tokens: row.reasoningTokens,
        cached_tokens: row.cachedTokens,
        total_tokens: row.totalTokens,
      },
    }));

    const content = JSON.stringify(payload, null, 2);
    const fileTime = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob({
      filename: `usage-events-${fileTime}.json`,
      blob: new Blob([content], { type: 'application/json;charset=utf-8' }),
    });
  };

  return (
    <Card
      title={t('usage_stats.request_events_title')}
      extra={
        <div className={styles.requestEventsActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearFilters}
            disabled={!hasActiveFilters}
          >
            {t('usage_stats.clear_filters')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportCsv}
            disabled={filteredRows.length === 0}
          >
            {t('usage_stats.export_csv')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportJson}
            disabled={filteredRows.length === 0}
          >
            {t('usage_stats.export_json')}
          </Button>
        </div>
      }
    >
      <div className={styles.requestEventsToolbar}>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_model')}
          </span>
          <Select
            value={effectiveModelFilter}
            options={modelOptions}
            onChange={setModelFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_model')}
            fullWidth={false}
          />
        </div>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_source')}
          </span>
          <Select
            value={effectiveSourceFilter}
            options={sourceOptions}
            onChange={setSourceFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_source')}
            fullWidth={false}
          />
        </div>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_auth_index')}
          </span>
          <Select
            value={effectiveAuthIndexFilter}
            options={authIndexOptions}
            onChange={setAuthIndexFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_auth_index')}
            fullWidth={false}
          />
        </div>
      </div>

      {loading && rows.length === 0 ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('usage_stats.request_events_empty_title')}
          description={t('usage_stats.request_events_empty_desc')}
        />
      ) : filteredRows.length === 0 ? (
        <EmptyState
          title={t('usage_stats.request_events_no_result_title')}
          description={t('usage_stats.request_events_no_result_desc')}
        />
      ) : (
        <>
          <div className={styles.requestEventsMeta}>
            <span>{t('usage_stats.request_events_count', { count: filteredRows.length })}</span>
            {hasLatencyData && <span className={styles.requestEventsLimitHint}>{latencyHint}</span>}
            {filteredRows.length > MAX_RENDERED_EVENTS && (
              <span className={styles.requestEventsLimitHint}>
                {t('usage_stats.request_events_limit_hint', {
                  shown: MAX_RENDERED_EVENTS,
                  total: filteredRows.length,
                })}
              </span>
            )}
          </div>

          <div className={styles.requestEventsTableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t('usage_stats.request_events_timestamp')}</th>
                  <th>{t('usage_stats.model_name')}</th>
                  <th>{t('usage_stats.request_events_source')}</th>
                  <th>{t('usage_stats.request_events_auth_index')}</th>
                  <th>{t('usage_stats.request_events_result')}</th>
                  <th>{t('usage_stats.request_events_status_code')}</th>
                  {hasLatencyData && <th title={latencyHint}>{t('usage_stats.time')}</th>}
                  <th>{t('usage_stats.thinking_intensity')}</th>
                  <th>{t('usage_stats.input_tokens')}</th>
                  <th>{t('usage_stats.output_tokens')}</th>
                  <th>{t('usage_stats.reasoning_tokens')}</th>
                  <th>{t('usage_stats.cached_tokens')}</th>
                  <th>{t('usage_stats.total_tokens')}</th>
                  <th>{t('usage_stats.request_events_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {renderedRows.map((row) => (
                  <tr key={row.id}>
                    <td title={row.timestamp} className={styles.requestEventsTimestamp}>
                      {row.timestampLabel}
                    </td>
                    <td className={styles.modelCell}>{row.model}</td>
                    <td className={styles.requestEventsSourceCell} title={row.source}>
                      <span>{row.source}</span>
                      {row.sourceType && (
                        <span className={styles.credentialType}>{row.sourceType}</span>
                      )}
                    </td>
                    <td className={styles.requestEventsAuthIndex} title={row.authIndex}>
                      {row.authIndex}
                    </td>
                    <td>
                      <span
                        className={
                          row.failed
                            ? styles.requestEventsResultFailed
                            : styles.requestEventsResultSuccess
                        }
                      >
                        {row.failed ? t('stats.failure') : t('stats.success')}
                      </span>
                    </td>
                    <td>
                      {typeof getDisplayStatusCode(row.statusCode, row.upstreamStatusCode) === 'number' ? (
                        <span className={styles.requestEventsStatusBadge}>
                          {getDisplayStatusCode(row.statusCode, row.upstreamStatusCode)}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    {hasLatencyData && (
                      <td className={styles.durationCell}>{formatDurationMs(row.latencyMs)}</td>
                    )}
                    <td>
                      <span
                        className={
                          row.thinking
                            ? styles.requestEventsThinkingBadge
                            : styles.requestEventsThinkingEmpty
                        }
                        title={
                          row.thinking
                            ? [
                                row.thinking.mode
                                  ? `${t('usage_stats.thinking_mode')}: ${row.thinking.mode}`
                                  : '',
                                row.thinking.level
                                  ? `${t('usage_stats.thinking_level')}: ${row.thinking.level}`
                                  : '',
                                typeof row.thinking.budget === 'number'
                                  ? `${t('usage_stats.thinking_budget')}: ${row.thinking.budget.toLocaleString()}`
                                  : '',
                              ]
                                .filter(Boolean)
                                .join(' · ')
                            : undefined
                        }
                      >
                        {row.thinkingLabel}
                      </span>
                    </td>
                    <td>{row.inputTokens.toLocaleString()}</td>
                    <td>{row.outputTokens.toLocaleString()}</td>
                    <td>{row.reasoningTokens.toLocaleString()}</td>
                    <td>{row.cachedTokens.toLocaleString()}</td>
                    <td>{row.totalTokens.toLocaleString()}</td>
                    <td className={styles.requestEventsActionCell}>
                      {row.failed ? (
                        <Button variant="secondary" size="sm" onClick={() => void handleOpenDetail(row)}>
                          {t('common.details')}
                        </Button>
                      ) : (
                        '-'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Modal
        open={detailRow !== null}
        title={detailRow ? `${t('usage_stats.request_events_detail_title')} · ${detailRow.model}` : ''}
        onClose={() => setDetailRow(null)}
        width={760}
      >
        {detailRow && (
          <div className={styles.requestDetailPanel}>
            <div className={styles.requestDetailGrid}>
              <div className={styles.requestDetailItem}>
                <span className={styles.requestDetailLabel}>{t('usage_stats.request_events_request_id')}</span>
                <span className={styles.requestDetailValue}>{detailRow.requestId || '-'}</span>
              </div>
              <div className={styles.requestDetailItem}>
                <span className={styles.requestDetailLabel}>{t('usage_stats.request_events_method')}</span>
                <span className={styles.requestDetailValue}>
                  {detailData?.method || detailRow.method || '-'}
                </span>
              </div>
              <div className={styles.requestDetailItem}>
                <span className={styles.requestDetailLabel}>{t('usage_stats.request_events_path')}</span>
                <span className={styles.requestDetailValue}>
                  {detailData?.path || detailRow.path || '-'}
                </span>
              </div>
              <div className={styles.requestDetailItem}>
                <span className={styles.requestDetailLabel}>{t('usage_stats.request_events_status_code')}</span>
                <span className={styles.requestDetailValue}>
                  {getDisplayStatusCode(
                    detailData?.status_code ?? detailRow.statusCode,
                    detailData?.upstream_status_code ?? detailRow.upstreamStatusCode
                  ) ?? '-'}
                </span>
              </div>
              <div className={styles.requestDetailItem}>
                <span className={styles.requestDetailLabel}>{t('usage_stats.request_events_latency')}</span>
                <span className={styles.requestDetailValue}>
                  {detailData?.latency_ms ?? detailRow.latencyMs ?? '-'}
                </span>
              </div>
              <div className={styles.requestDetailItem}>
                <span className={styles.requestDetailLabel}>{t('usage_stats.request_events_error_stage')}</span>
                <span className={styles.requestDetailValue}>
                  {detailData?.error?.stage || detailRow.errorStage || '-'}
                </span>
              </div>
              <div className={styles.requestDetailItem}>
                <span className={styles.requestDetailLabel}>{t('usage_stats.request_events_error_code')}</span>
                <span className={styles.requestDetailValue}>
                  {detailData?.error?.code || detailRow.errorCode || '-'}
                </span>
              </div>
            </div>

            {detailLoading && <div className={styles.hint}>{t('usage_stats.request_events_detail_loading')}</div>}
            {!detailLoading && detailError && <div className="error-box">{detailError}</div>}

            {(detailData?.error || detailRow.errorMessage || detailRow.upstreamErrorMessage) && (
              <div className={styles.requestDetailSection}>
                <div className={styles.requestDetailSectionTitle}>
                  {t('usage_stats.request_events_error_summary')}
                </div>
                <pre className={styles.requestDetailPre}>
                  {detailData?.error?.message ||
                    detailData?.error?.upstream_message ||
                    detailRow.errorMessage ||
                    detailRow.upstreamErrorMessage ||
                    '-'}
                </pre>
              </div>
            )}

            {(detailData?.upstream?.body_json !== undefined ||
              detailData?.upstream?.body_text !== undefined) && (
              <div className={styles.requestDetailSection}>
                <div className={styles.requestDetailSectionTitle}>
                  {t('usage_stats.request_events_upstream_body')}
                </div>
                {detailData?.upstream?.body_json !== undefined && (
                  <pre className={styles.requestDetailPre}>
                    {stringifyData(detailData.upstream.body_json)}
                  </pre>
                )}
                {detailData?.upstream?.body_json === undefined && detailData?.upstream?.body_text && (
                  <pre className={styles.requestDetailPre}>{detailData.upstream.body_text}</pre>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>
    </Card>
  );
}
