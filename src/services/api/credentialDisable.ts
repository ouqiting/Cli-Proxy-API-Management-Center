import { authFilesApi } from './authFiles';
import { providersApi } from './providers';
import type { AuthFileItem, GeminiKeyConfig, OpenAIProviderConfig, ProviderKeyConfig } from '@/types';

const DISABLE_ALL_MODELS_RULE = '*';

export type ProviderKeyKind = 'gemini' | 'codex' | 'claude' | 'vertex';

export type DisableCredentialTarget =
  | {
      kind: 'auth_file';
      name: string;
      authIndex?: string | null;
      displayName: string;
      disabled: boolean;
    }
  | {
      kind: 'provider_key';
      providerKind: ProviderKeyKind;
      apiKey: string;
      prefix?: string;
      displayName: string;
      disabled: boolean;
    }
  | {
      kind: 'openai_api_key_entry';
      providerName: string;
      providerBaseUrl: string;
      apiKey: string;
      displayName: string;
      disabled: boolean;
    };

export interface CredentialDisableSnapshot {
  authFiles: AuthFileItem[];
  geminiKeys: GeminiKeyConfig[];
  codexConfigs: ProviderKeyConfig[];
  claudeConfigs: ProviderKeyConfig[];
  vertexConfigs: ProviderKeyConfig[];
  openaiProviders: OpenAIProviderConfig[];
}

const stripDisableAllModelsRule = (models?: string[]) =>
  Array.isArray(models)
    ? models.filter((model) => String(model ?? '').trim() !== DISABLE_ALL_MODELS_RULE)
    : [];

const withDisableAllModelsRule = (models?: string[]) => {
  const base = stripDisableAllModelsRule(models);
  return [...base, DISABLE_ALL_MODELS_RULE];
};

const withoutDisableAllModelsRule = (models?: string[]) => stripDisableAllModelsRule(models);

const isProviderKeyDisabled = (models?: string[]) =>
  Array.isArray(models) &&
  models.some((model) => String(model ?? '').trim() === DISABLE_ALL_MODELS_RULE);

const updateProviderKeyList = <T extends ProviderKeyConfig | GeminiKeyConfig>(
  list: T[],
  apiKey: string,
  disabled: boolean
) =>
  list.map((item) => {
    if (item.apiKey !== apiKey) return item;
    return {
      ...item,
      excludedModels: disabled
        ? withDisableAllModelsRule(item.excludedModels)
        : withoutDisableAllModelsRule(item.excludedModels),
    } as T;
  });

export async function loadCredentialDisableSnapshot(): Promise<CredentialDisableSnapshot> {
  const [
    authFilesResponse,
    geminiKeys,
    codexConfigs,
    claudeConfigs,
    vertexConfigs,
    openaiProviders,
  ] = await Promise.all([
    authFilesApi.list(),
    providersApi.getGeminiKeys(),
    providersApi.getCodexConfigs(),
    providersApi.getClaudeConfigs(),
    providersApi.getVertexConfigs(),
    providersApi.getOpenAIProviders(),
  ]);

  return {
    authFiles: authFilesResponse?.files || [],
    geminiKeys,
    codexConfigs,
    claudeConfigs,
    vertexConfigs,
    openaiProviders,
  };
}

export async function setAuthFileDisabledState(name: string, disabled: boolean) {
  await authFilesApi.setStatus(name, disabled);
}

export async function setProviderKeyDisabledState(
  providerKind: ProviderKeyKind,
  apiKey: string,
  disabled: boolean
) {
  if (providerKind === 'gemini') {
    const current = await providersApi.getGeminiKeys();
    const next = updateProviderKeyList(current, apiKey, disabled);
    await providersApi.saveGeminiKeys(next);
    return;
  }

  if (providerKind === 'codex') {
    const current = await providersApi.getCodexConfigs();
    const next = updateProviderKeyList(current, apiKey, disabled);
    await providersApi.saveCodexConfigs(next);
    return;
  }

  if (providerKind === 'claude') {
    const current = await providersApi.getClaudeConfigs();
    const next = updateProviderKeyList(current, apiKey, disabled);
    await providersApi.saveClaudeConfigs(next);
    return;
  }

  const current = await providersApi.getVertexConfigs();
  const next = updateProviderKeyList(current, apiKey, disabled);
  await providersApi.saveVertexConfigs(next);
}

export async function setOpenAIApiKeyEntryDisabledState(
  providerName: string,
  providerBaseUrl: string,
  apiKey: string,
  disabled: boolean
) {
  await providersApi.setOpenAIApiKeyEntryStatus(
    providerName,
    providerBaseUrl,
    apiKey,
    disabled
  );
}

export { isProviderKeyDisabled };
