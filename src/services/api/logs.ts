/**
 * 日志相关 API
 */

import { apiClient } from './client';
import { LOGS_TIMEOUT_MS } from '@/utils/constants';

export interface LogsQuery {
  after?: number;
}

export interface LogsResponse {
  lines: string[];
  'line-count': number;
  'latest-timestamp': number;
}

export interface ErrorLogFile {
  name: string;
  size?: number;
  modified?: number;
}

export interface ErrorLogsResponse {
  files?: ErrorLogFile[];
}

export interface RequestLogDetailError {
  stage?: string;
  type?: string;
  code?: string;
  message?: string;
  upstream_message?: string;
}

export interface RequestLogDetailUpstream {
  request_id?: string;
  body_text?: string;
  body_json?: unknown;
  truncated?: boolean;
}

export interface RequestLogDetailResponse {
  request_id?: string;
  timestamp?: string;
  method?: string;
  path?: string;
  model?: string;
  source?: string;
  auth_index?: string | number;
  failed?: boolean;
  status_code?: number;
  upstream_status_code?: number;
  latency_ms?: number;
  error?: RequestLogDetailError;
  upstream?: RequestLogDetailUpstream;
  [key: string]: unknown;
}

export const logsApi = {
  fetchLogs: (params: LogsQuery = {}): Promise<LogsResponse> =>
    apiClient.get('/logs', { params, timeout: LOGS_TIMEOUT_MS }),

  clearLogs: () => apiClient.delete('/logs'),

  fetchErrorLogs: (): Promise<ErrorLogsResponse> =>
    apiClient.get('/request-error-logs', { timeout: LOGS_TIMEOUT_MS }),

  downloadErrorLog: (filename: string) =>
    apiClient.getRaw(`/request-error-logs/${encodeURIComponent(filename)}`, {
      responseType: 'blob',
      timeout: LOGS_TIMEOUT_MS
    }),

  downloadRequestLogById: (id: string) =>
    apiClient.getRaw(`/request-log-by-id/${encodeURIComponent(id)}`, {
      responseType: 'blob',
      timeout: LOGS_TIMEOUT_MS
    }),

  fetchRequestLogDetail: (id: string): Promise<RequestLogDetailResponse> =>
    apiClient.get(`/request-log-by-id/${encodeURIComponent(id)}`, {
      params: { format: 'json' },
      headers: { Accept: 'application/json' },
      timeout: LOGS_TIMEOUT_MS
    }),
};
