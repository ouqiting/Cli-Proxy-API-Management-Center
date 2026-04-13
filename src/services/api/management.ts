import { apiClient } from './client';

export interface ManagementActionLog {
  time: string;
  level: string;
  message: string;
}

export interface WebuiUpdateResponse {
  success: boolean;
  updated: boolean;
  message: string;
  file_path?: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  logs?: ManagementActionLog[];
  error?: string;
}

export interface SystemRestartResponse {
  accepted: boolean;
  message: string;
  command?: string;
}

export const managementApi = {
  updateWebui: (force = false) =>
    apiClient.post<WebuiUpdateResponse>('/webui/update', force ? { force: true } : undefined),

  restartSystem: () => apiClient.post<SystemRestartResponse>('/system/restart'),
};
