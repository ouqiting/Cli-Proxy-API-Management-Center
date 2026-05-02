import type { AxiosRequestConfig } from 'axios';
import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  CodexQuotaWindow,
  CodexRateLimitInfo,
  CodexUsagePayload,
  CodexUsageWindow,
} from '@/types';
import { apiCallApi, authFilesApi, getApiCallErrorMessage } from '@/services/api';
import { normalizeAuthIndex } from '@/utils/usage';
import { useDisabledCredentialsStore } from '@/stores';
import { CODEX_REQUEST_HEADERS, CODEX_USAGE_URL } from './constants';
import { createStatusError, formatCodexResetLabel } from './formatters';
import { normalizeNumberValue, normalizePlanType, parseCodexUsagePayload } from './parsers';
import { resolveCodexChatgptAccountId, resolveCodexPlanType } from './resolvers';

export type CodexQuotaQueryResult = {
  planType: string | null;
  windows: CodexQuotaWindow[];
};

export type CodexPriorityAssignment = {
  file: AuthFileItem;
  planType: string | null;
  priority: number;
  remainingPercent: number | null;
};

export type PersistCodexPriorityAssignmentsResult = {
  updatedCount: number;
  failedResults: Array<{ fileName: string; message: string }>;
};

const AUTH_FILE_RUNTIME_ONLY_KEYS = new Set([
  'name',
  'size',
  'source',
  'path',
  'runtimeOnly',
  'runtime_only',
  'disabled',
  'unavailable',
  'status',
  'statusMessage',
  'lastRefresh',
  'last_refresh',
  'modified',
  'modtime',
  'updated_at',
]);

const FIVE_HOUR_SECONDS = 18000;
const WEEK_SECONDS = 604800;

const WINDOW_META = {
  codeFiveHour: { id: 'five-hour', labelKey: 'codex_quota.primary_window' },
  codeWeekly: { id: 'weekly', labelKey: 'codex_quota.secondary_window' },
  codeReviewFiveHour: {
    id: 'code-review-five-hour',
    labelKey: 'codex_quota.code_review_primary_window',
  },
  codeReviewWeekly: {
    id: 'code-review-weekly',
    labelKey: 'codex_quota.code_review_secondary_window',
  },
} as const;

const mergeDownloadedCodexFile = async (file: AuthFileItem): Promise<AuthFileItem> => {
  const downloaded = await authFilesApi.downloadJsonObject(file.name);
  return {
    ...file,
    ...(downloaded as AuthFileItem),
  };
};

export const resolveCodexChatgptAccountIdWithFallback = async (
  file: AuthFileItem
): Promise<string | null> => {
  const direct = resolveCodexChatgptAccountId(file);
  if (direct) return direct;

  try {
    const merged = await mergeDownloadedCodexFile(file);
    return resolveCodexChatgptAccountId(merged);
  } catch {
    return null;
  }
};

const getWindowSeconds = (window?: CodexUsageWindow | null): number | null => {
  if (!window) return null;
  return normalizeNumberValue(window.limit_window_seconds ?? window.limitWindowSeconds);
};

const pickClassifiedWindows = (
  limitInfo?: CodexRateLimitInfo | null,
  options?: { allowOrderFallback?: boolean }
): { fiveHourWindow: CodexUsageWindow | null; weeklyWindow: CodexUsageWindow | null } => {
  const allowOrderFallback = options?.allowOrderFallback ?? true;
  const primaryWindow = limitInfo?.primary_window ?? limitInfo?.primaryWindow ?? null;
  const secondaryWindow = limitInfo?.secondary_window ?? limitInfo?.secondaryWindow ?? null;
  const rawWindows = [primaryWindow, secondaryWindow];

  let fiveHourWindow: CodexUsageWindow | null = null;
  let weeklyWindow: CodexUsageWindow | null = null;

  for (const window of rawWindows) {
    if (!window) continue;
    const seconds = getWindowSeconds(window);
    if (seconds === FIVE_HOUR_SECONDS && !fiveHourWindow) {
      fiveHourWindow = window;
    } else if (seconds === WEEK_SECONDS && !weeklyWindow) {
      weeklyWindow = window;
    }
  }

  if (allowOrderFallback) {
    if (!fiveHourWindow) {
      fiveHourWindow = primaryWindow && primaryWindow !== weeklyWindow ? primaryWindow : null;
    }
    if (!weeklyWindow) {
      weeklyWindow = secondaryWindow && secondaryWindow !== fiveHourWindow ? secondaryWindow : null;
    }
  }

  return { fiveHourWindow, weeklyWindow };
};

const normalizeWindowId = (raw: string) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const buildCodexQuotaWindows = (
  payload: CodexUsagePayload,
  t: TFunction
): CodexQuotaWindow[] => {
  const rateLimit = payload.rate_limit ?? payload.rateLimit ?? undefined;
  const codeReviewLimit = payload.code_review_rate_limit ?? payload.codeReviewRateLimit ?? undefined;
  const additionalRateLimits = payload.additional_rate_limits ?? payload.additionalRateLimits ?? [];
  const windows: CodexQuotaWindow[] = [];

  const addWindow = (
    id: string,
    label: string,
    labelKey: string | undefined,
    labelParams: Record<string, string | number> | undefined,
    window?: CodexUsageWindow | null,
    limitReached?: boolean,
    allowed?: boolean
  ) => {
    if (!window) return;
    const resetLabel = formatCodexResetLabel(window);
    const usedPercentRaw = normalizeNumberValue(window.used_percent ?? window.usedPercent);
    const isLimitReached = Boolean(limitReached) || allowed === false;
    const usedPercent = usedPercentRaw ?? (isLimitReached && resetLabel !== '-' ? 100 : null);
    windows.push({
      id,
      label,
      labelKey,
      labelParams,
      usedPercent,
      resetLabel,
    });
  };

  const rawLimitReached = rateLimit?.limit_reached ?? rateLimit?.limitReached;
  const rawAllowed = rateLimit?.allowed;
  const rateWindows = pickClassifiedWindows(rateLimit);
  addWindow(
    WINDOW_META.codeFiveHour.id,
    t(WINDOW_META.codeFiveHour.labelKey),
    WINDOW_META.codeFiveHour.labelKey,
    undefined,
    rateWindows.fiveHourWindow,
    rawLimitReached,
    rawAllowed
  );
  addWindow(
    WINDOW_META.codeWeekly.id,
    t(WINDOW_META.codeWeekly.labelKey),
    WINDOW_META.codeWeekly.labelKey,
    undefined,
    rateWindows.weeklyWindow,
    rawLimitReached,
    rawAllowed
  );

  const codeReviewWindows = pickClassifiedWindows(codeReviewLimit);
  const codeReviewLimitReached = codeReviewLimit?.limit_reached ?? codeReviewLimit?.limitReached;
  const codeReviewAllowed = codeReviewLimit?.allowed;
  addWindow(
    WINDOW_META.codeReviewFiveHour.id,
    t(WINDOW_META.codeReviewFiveHour.labelKey),
    WINDOW_META.codeReviewFiveHour.labelKey,
    undefined,
    codeReviewWindows.fiveHourWindow,
    codeReviewLimitReached,
    codeReviewAllowed
  );
  addWindow(
    WINDOW_META.codeReviewWeekly.id,
    t(WINDOW_META.codeReviewWeekly.labelKey),
    WINDOW_META.codeReviewWeekly.labelKey,
    undefined,
    codeReviewWindows.weeklyWindow,
    codeReviewLimitReached,
    codeReviewAllowed
  );

  if (Array.isArray(additionalRateLimits)) {
    additionalRateLimits.forEach((limitItem, index) => {
      const rateInfo = limitItem?.rate_limit ?? limitItem?.rateLimit ?? null;
      if (!rateInfo) return;

      const limitName =
        String(limitItem?.limit_name ?? limitItem?.limitName ?? '').trim() ||
        String(limitItem?.metered_feature ?? limitItem?.meteredFeature ?? '').trim() ||
        `additional-${index + 1}`;

      const idPrefix = normalizeWindowId(limitName) || `additional-${index + 1}`;
      const additionalLimitReached = rateInfo.limit_reached ?? rateInfo.limitReached;
      const additionalAllowed = rateInfo.allowed;

      addWindow(
        `${idPrefix}-five-hour-${index}`,
        t('codex_quota.additional_primary_window', { name: limitName }),
        'codex_quota.additional_primary_window',
        { name: limitName },
        rateInfo.primary_window ?? rateInfo.primaryWindow ?? null,
        additionalLimitReached,
        additionalAllowed
      );
      addWindow(
        `${idPrefix}-weekly-${index}`,
        t('codex_quota.additional_secondary_window', { name: limitName }),
        'codex_quota.additional_secondary_window',
        { name: limitName },
        rateInfo.secondary_window ?? rateInfo.secondaryWindow ?? null,
        additionalLimitReached,
        additionalAllowed
      );
    });
  }

  return windows;
};

export const resolveCodexBulkFailureMessage = (
  data: { planType: string | null; windows: CodexQuotaWindow[] },
  t: TFunction
): string | null => {
  const normalizedPlanType = normalizePlanType(data.planType);

  if (normalizedPlanType === 'free' && data.windows.length === 0) {
    return t('codex_quota.no_access');
  }

  if (data.windows.length === 0) {
    return t('codex_quota.empty_windows');
  }

  return null;
};

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

const resolveCodexPlanPriorityGroup = (planType: string | null): number => {
  const normalizedPlanType = normalizePlanType(planType) ?? '';
  if (normalizedPlanType.includes('free')) return 0;
  if (normalizedPlanType.includes('plus') || normalizedPlanType.includes('pro')) return 1;
  return 1;
};

export const resolveCodexRemainingPercent = (windows: CodexQuotaWindow[]): number | null => {
  const remainingPercents = windows
    .map((window) => normalizeNumberValue(window.usedPercent))
    .filter((value): value is number => value !== null)
    .map((usedPercent) => clampPercent(100 - usedPercent));

  if (remainingPercents.length === 0) {
    return null;
  }

  return Math.min(...remainingPercents);
};

export const buildCodexPriorityAssignments = (
  entries: Array<{ file: AuthFileItem; data: CodexQuotaQueryResult }>
): CodexPriorityAssignment[] => {
  const sortedEntries = [...entries].sort((left, right) => {
    const planGroupDiff =
      resolveCodexPlanPriorityGroup(left.data.planType) -
      resolveCodexPlanPriorityGroup(right.data.planType);
    if (planGroupDiff !== 0) return planGroupDiff;

    const leftRemainingPercent = resolveCodexRemainingPercent(left.data.windows);
    const rightRemainingPercent = resolveCodexRemainingPercent(right.data.windows);
    const normalizedLeftRemaining =
      leftRemainingPercent === null ? Number.POSITIVE_INFINITY : leftRemainingPercent;
    const normalizedRightRemaining =
      rightRemainingPercent === null ? Number.POSITIVE_INFINITY : rightRemainingPercent;

    if (normalizedLeftRemaining !== normalizedRightRemaining) {
      return normalizedLeftRemaining - normalizedRightRemaining;
    }

    return left.file.name.localeCompare(right.file.name, undefined, {
      sensitivity: 'accent',
    });
  });

  const total = sortedEntries.length;
  return sortedEntries.map((entry, index) => ({
    file: entry.file,
    planType: entry.data.planType,
    priority: total - index,
    remainingPercent: resolveCodexRemainingPercent(entry.data.windows),
  }));
};

export const persistCodexPriorityAssignments = async (
  assignments: CodexPriorityAssignment[]
): Promise<PersistCodexPriorityAssignmentsResult> => {
  const failedResults: Array<{ fileName: string; message: string }> = [];
  let updatedCount = 0;

  const results = await Promise.allSettled(
    assignments.map(async (assignment) => {
      const currentPriority = assignment.file.priority;
      const normalizedCurrentPriority =
        typeof currentPriority === 'number'
          ? currentPriority
          : typeof currentPriority === 'string' && currentPriority.trim()
            ? Number(currentPriority)
            : null;

      if (normalizedCurrentPriority === assignment.priority) {
        return;
      }

      const fileJson = Object.entries(assignment.file).reduce<Record<string, unknown>>(
        (result, [key, value]) => {
          if (AUTH_FILE_RUNTIME_ONLY_KEYS.has(key)) {
            return result;
          }
          if (value === undefined) {
            return result;
          }
          result[key] = value;
          return result;
        },
        {}
      );

      await authFilesApi.saveJsonObject(assignment.file.name, {
        ...fileJson,
        priority: assignment.priority,
      });
      updatedCount += 1;
    })
  );

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      return;
    }

    const reason = result.reason;
    failedResults.push({
      fileName: assignments[index]?.file.name ?? 'Unknown',
      message: reason instanceof Error ? reason.message : 'Unknown error',
    });
  });

  return { updatedCount, failedResults };
};

export const fetchCodexQuotaData = async (
  file: AuthFileItem,
  t: TFunction,
  requestConfig?: AxiosRequestConfig
): Promise<CodexQuotaQueryResult> => {
  const rawAuthIndex = file['auth_index'] ?? file.authIndex;
  const authIndex = normalizeAuthIndex(rawAuthIndex);
  if (!authIndex) {
    throw new Error(t('codex_quota.missing_auth_index'));
  }

  const planTypeFromFile = resolveCodexPlanType(file);
  const accountId = await resolveCodexChatgptAccountIdWithFallback(file);
  if (!accountId) {
    throw new Error(t('codex_quota.missing_account_id'));
  }

  const requestHeader: Record<string, string> = {
    ...CODEX_REQUEST_HEADERS,
    'Chatgpt-Account-Id': accountId,
  };

  let result;
  try {
    result = await apiCallApi.request(
      {
        authIndex,
        method: 'GET',
        url: CODEX_USAGE_URL,
        header: requestHeader,
      },
      requestConfig
    );
  } catch (error: unknown) {
    // 检测429错误且包含"The usage limit has been reached"时自动禁用凭证
    if (error instanceof Error) {
      const errorStatus = (error as Error & { statusCode?: number }).statusCode;
      if (errorStatus === 429 && error.message.includes('The usage limit has been reached')) {
        try {
          const { setTargetDisabledState } = useDisabledCredentialsStore.getState();
          await setTargetDisabledState(
            {
              kind: 'auth_file',
              name: file.name,
              authIndex: authIndex,
              displayName: file.name,
              disabled: true,
            },
            true
          );
          console.log(`[Codex Quota] Auto-disabled credential ${file.name} due to 429 usage limit reached`);
        } catch (disableError) {
          console.warn('[Codex Quota] Failed to auto-disable credential:', disableError);
        }
      }
    }
    throw error;
  }

  if (result.statusCode < 200 || result.statusCode >= 300) {
    // 检测429状态码且错误信息包含"The usage limit has been reached"时自动禁用凭证
    if (result.statusCode === 429) {
      const errorMessage = getApiCallErrorMessage(result);
      if (errorMessage.includes('The usage limit has been reached')) {
        try {
          const { setTargetDisabledState } = useDisabledCredentialsStore.getState();
          await setTargetDisabledState(
            {
              kind: 'auth_file',
              name: file.name,
              authIndex: authIndex,
              displayName: file.name,
              disabled: true,
            },
            true
          );
          console.log(`[Codex Quota] Auto-disabled credential ${file.name} due to 429 usage limit reached`);
        } catch (disableError) {
          console.warn('[Codex Quota] Failed to auto-disable credential:', disableError);
        }
      }
    }
    throw createStatusError(getApiCallErrorMessage(result), result.statusCode);
  }

  const payload = parseCodexUsagePayload(result.body ?? result.bodyText);
  if (!payload) {
    throw new Error(t('codex_quota.empty_windows'));
  }

  const planTypeFromUsage = normalizePlanType(payload.plan_type ?? payload.planType);
  const windows = buildCodexQuotaWindows(payload, t);
  return { planType: planTypeFromUsage ?? planTypeFromFile, windows };
};
