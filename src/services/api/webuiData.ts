import { apiClient } from './client';

const WEBUI_DATA_ENDPOINT = '/webui-data';

interface WebuiDataFileResponse {
  path: string;
  type: 'file';
  content?: string;
  content_base64?: string;
  size?: number;
  modified?: number;
}

const getErrorStatus = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }
  const value = (error as { status?: unknown }).status;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const webuiDataApi = {
  async readTextFile(path: string): Promise<string> {
    const response = await apiClient.get<WebuiDataFileResponse>(WEBUI_DATA_ENDPOINT, {
      params: { path },
    });

    if (!response || response.type !== 'file') {
      throw new Error(`Path is not a file: ${path}`);
    }

    return typeof response.content === 'string' ? response.content : '';
  },

  writeTextFile(path: string, content: string): Promise<void> {
    return apiClient.put<void>(WEBUI_DATA_ENDPOINT, {
      path,
      content,
    });
  },

  deletePath(path: string): Promise<void> {
    return apiClient.delete<void>(WEBUI_DATA_ENDPOINT, {
      params: { path },
    });
  },

  isNotFoundError(error: unknown): boolean {
    return getErrorStatus(error) === 404;
  },
};
