import type {
  AntigravityQuotaState,
  ClaudeQuotaState,
  CodexQuotaState,
  GeminiCliQuotaState,
  KimiQuotaState,
  VercelQuotaState,
} from '@/types';
import { webuiDataApi } from './api/webuiData';

export const QUOTA_SNAPSHOT_PATH = 'usage/quota-snapshot.json';

export type QuotaSnapshotChannel =
  | 'antigravity'
  | 'claude'
  | 'codex'
  | 'vercel'
  | 'gemini-cli'
  | 'kimi';

export type QuotaSnapshotQueryTimes = Partial<Record<QuotaSnapshotChannel, number>>;

export interface QuotaSnapshotChannels {
  antigravity: Record<string, AntigravityQuotaState>;
  claude: Record<string, ClaudeQuotaState>;
  codex: Record<string, CodexQuotaState>;
  vercel: Record<string, VercelQuotaState>;
  'gemini-cli': Record<string, GeminiCliQuotaState>;
  kimi: Record<string, KimiQuotaState>;
}

export interface QuotaSnapshot {
  version: 1;
  updatedAt: string;
  queryTimes: QuotaSnapshotQueryTimes;
  channels: QuotaSnapshotChannels;
}

const EMPTY_CHANNELS: QuotaSnapshotChannels = {
  antigravity: {},
  claude: {},
  codex: {},
  vercel: {},
  'gemini-cli': {},
  kimi: {},
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const asStateMap = <TState>(value: unknown): Record<string, TState> => {
  const record = asRecord(value);
  if (!record) return {};
  return record as unknown as Record<string, TState>;
};

const asQueryTimes = (value: unknown): QuotaSnapshotQueryTimes => {
  const record = asRecord(value);
  if (!record) return {};

  const channels: QuotaSnapshotChannel[] = [
    'antigravity',
    'claude',
    'codex',
    'vercel',
    'gemini-cli',
    'kimi',
  ];

  const result: QuotaSnapshotQueryTimes = {};
  channels.forEach((channel) => {
    const raw = record[channel];
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      result[channel] = Math.trunc(parsed);
    }
  });
  return result;
};

const parseSnapshot = (text: string): QuotaSnapshot | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const parsed = asRecord(JSON.parse(trimmed));
  if (!parsed) return null;
  const channels = asRecord(parsed.channels);

  return {
    version: 1,
    updatedAt:
      typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim()
        ? parsed.updatedAt
        : new Date().toISOString(),
    queryTimes: asQueryTimes(parsed.queryTimes),
    channels: {
      antigravity: asStateMap<AntigravityQuotaState>(channels?.antigravity),
      claude: asStateMap<ClaudeQuotaState>(channels?.claude),
      codex: asStateMap<CodexQuotaState>(channels?.codex),
      vercel: asStateMap<VercelQuotaState>(channels?.vercel),
      'gemini-cli': asStateMap<GeminiCliQuotaState>(channels?.['gemini-cli']),
      kimi: asStateMap<KimiQuotaState>(channels?.kimi),
    },
  };
};

export async function readQuotaSnapshotRaw(): Promise<string | null> {
  try {
    return await webuiDataApi.readTextFile(QUOTA_SNAPSHOT_PATH);
  } catch (error: unknown) {
    if (webuiDataApi.isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function readQuotaSnapshot(): Promise<QuotaSnapshot | null> {
  const raw = await readQuotaSnapshotRaw();
  if (raw === null) return null;
  try {
    return parseSnapshot(raw);
  } catch (error) {
    console.warn('[Quota Snapshot] Failed to parse snapshot:', error);
    return null;
  }
}

export async function writeQuotaSnapshotRaw(content: string): Promise<void> {
  await webuiDataApi.writeTextFile(QUOTA_SNAPSHOT_PATH, content);
}

export async function writeQuotaSnapshot(input: {
  queryTimes: QuotaSnapshotQueryTimes;
  channels: Partial<QuotaSnapshotChannels>;
}): Promise<void> {
  const payload: QuotaSnapshot = {
    version: 1,
    updatedAt: new Date().toISOString(),
    queryTimes: input.queryTimes,
    channels: {
      ...EMPTY_CHANNELS,
      ...input.channels,
    },
  };

  await writeQuotaSnapshotRaw(JSON.stringify(payload, null, 2));
}

