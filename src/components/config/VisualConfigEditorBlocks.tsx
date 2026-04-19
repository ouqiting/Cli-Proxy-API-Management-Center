import { memo, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { modelsApi } from '@/services/api/models';
import { useAuthStore, useNotificationStore } from '@/stores';
import styles from './VisualConfigEditor.module.scss';
import { copyToClipboard } from '@/utils/clipboard';
import type {
  PayloadFilterRule,
  PayloadModelEntry,
  PayloadParamEntry,
  PayloadParamValidationErrorCode,
  PayloadParamValueType,
  PayloadRule,
  VisualConfigApiKeyEntry,
} from '@/types/visualConfig';
import { makeClientId } from '@/types/visualConfig';
import {
  getPayloadParamValidationError,
  VISUAL_CONFIG_PAYLOAD_VALUE_TYPE_OPTIONS,
  VISUAL_CONFIG_PROTOCOL_OPTIONS,
} from '@/hooks/useVisualConfig';
import { maskApiKey } from '@/utils/format';
import { isValidApiKeyCharset } from '@/utils/validation';

function getValidationMessage(
  t: ReturnType<typeof useTranslation>['t'],
  errorCode?: PayloadParamValidationErrorCode
) {
  if (!errorCode) return undefined;
  return t(`config_management.visual.validation.${errorCode}`);
}

function buildProtocolOptions(
  t: ReturnType<typeof useTranslation>['t'],
  rules: Array<{ models: PayloadModelEntry[] }>
) {
  const options: Array<{ value: string; label: string }> = VISUAL_CONFIG_PROTOCOL_OPTIONS.map(
    (option) => ({
      value: option.value,
      label: t(option.labelKey, { defaultValue: option.defaultLabel }),
    })
  );
  const seen = new Set<string>(options.map((option) => option.value));

  for (const rule of rules) {
    for (const model of rule.models) {
      const protocol = model.protocol;
      if (!protocol || !protocol.trim() || seen.has(protocol)) continue;
      seen.add(protocol);
      options.push({ value: protocol, label: protocol });
    }
  }

  return options;
}

function normalizeUniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  items.forEach((item) => {
    const trimmed = String(item ?? '').trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    normalized.push(trimmed);
  });

  return normalized.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

function normalizeApiKeyEntries(entries: VisualConfigApiKeyEntry[]): VisualConfigApiKeyEntry[] {
  return entries
    .map((entry, index) => {
      const apiKey = String(entry.apiKey ?? '').trim();
      if (!apiKey) return null;

      return {
        id: entry.id || `api-key-${index}-${makeClientId()}`,
        apiKey,
        disabledModels: normalizeUniqueStrings(entry.disabledModels ?? []),
      };
    })
    .filter(Boolean) as VisualConfigApiKeyEntry[];
}

type ApiKeyModelsModalProps = {
  open: boolean;
  apiKeyEntry: VisualConfigApiKeyEntry | null;
  disabled?: boolean;
  onClose: () => void;
  onSave: (disabledModels: string[]) => void;
};

function ApiKeyModelsModal({
  open,
  apiKeyEntry,
  disabled = false,
  onClose,
  onSave,
}: ApiKeyModelsModalProps) {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const [remoteModelNames, setRemoteModelNames] = useState<string[]>([]);
  const [customModelNames, setCustomModelNames] = useState<string[]>([]);
  const [draftDisabledModels, setDraftDisabledModels] = useState<string[]>([]);
  const [manualModelName, setManualModelName] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!open || !apiKeyEntry) return;
    setDraftDisabledModels(normalizeUniqueStrings(apiKeyEntry.disabledModels ?? []));
    setCustomModelNames([]);
    setManualModelName('');
  }, [apiKeyEntry, open]);

  useEffect(() => {
    if (!open || !apiKeyEntry?.apiKey || !apiBase) {
      setRemoteModelNames([]);
      setLoadingModels(false);
      setLoadError('');
      return;
    }

    let cancelled = false;
    setLoadingModels(true);
    setLoadError('');

    modelsApi
      .fetchModels(apiBase, apiKeyEntry.apiKey)
      .then((models) => {
        if (cancelled) return;
        setRemoteModelNames(normalizeUniqueStrings(models.map((model) => model.name)));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : '';
        setRemoteModelNames([]);
        setLoadError(message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingModels(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, apiKeyEntry, open]);

  const candidateModelNames = useMemo(
    () =>
      normalizeUniqueStrings([
        ...remoteModelNames,
        ...(apiKeyEntry?.disabledModels ?? []),
        ...customModelNames,
        ...draftDisabledModels,
      ]),
    [apiKeyEntry?.disabledModels, customModelNames, draftDisabledModels, remoteModelNames]
  );

  const disabledSet = useMemo(
    () => new Set(draftDisabledModels.map((item) => item.toLowerCase())),
    [draftDisabledModels]
  );

  const handleToggleModel = (modelName: string, enabled: boolean) => {
    setDraftDisabledModels((prev) => {
      const current = new Set(prev.map((item) => item.toLowerCase()));
      if (enabled) {
        current.delete(modelName.toLowerCase());
      } else {
        current.add(modelName.toLowerCase());
      }

      return candidateModelNames.filter((name) => current.has(name.toLowerCase()));
    });
  };

  const handleAddManualModel = () => {
    const trimmed = manualModelName.trim();
    if (!trimmed) return;
    setCustomModelNames((prev) => normalizeUniqueStrings([...prev, trimmed]));
    setManualModelName('');
  };

  const handleSelectAll = () => {
    setDraftDisabledModels([]);
  };

  const handleClearAll = () => {
    setDraftDisabledModels(candidateModelNames);
  };

  const handleSave = () => {
    onSave(normalizeUniqueStrings(draftDisabledModels));
    onClose();
  };

  const loadedHint = loadingModels
    ? t('config_management.visual.api_keys.models_loading')
    : loadError
      ? t('config_management.visual.api_keys.models_fetch_failed', { message: loadError })
      : candidateModelNames.length > 0
        ? t('config_management.visual.api_keys.models_loaded', { count: candidateModelNames.length })
        : t('config_management.visual.api_keys.no_models_available');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('config_management.visual.api_keys.models_title')}
      width={680}
      footer={
        <>
          <Button variant="secondary" onClick={handleSelectAll} disabled={disabled}>
            {t('config_management.visual.api_keys.select_all')}
          </Button>
          <Button
            variant="secondary"
            onClick={handleClearAll}
            disabled={disabled || candidateModelNames.length === 0}
          >
            {t('config_management.visual.api_keys.clear_all')}
          </Button>
          <Button onClick={handleSave} disabled={disabled}>
            {t('config_management.visual.api_keys.save_models')}
          </Button>
        </>
      }
    >
      <div className={styles.apiKeyModelsModalBody}>
        <div className={styles.apiKeyModelsSummary}>
          <div className={styles.apiKeyModelsSummaryTitle}>
            {maskApiKey(apiKeyEntry?.apiKey ?? '')}
          </div>
          <div className={styles.apiKeyModelsSummaryText}>
            {t('config_management.visual.api_keys.models_hint')}
          </div>
          <div className={styles.apiKeyModelsStatus}>{loadedHint}</div>
        </div>

        <div className={styles.apiKeyModelsManualAdd}>
          <input
            className="input"
            placeholder={t('config_management.visual.api_keys.manual_model_placeholder')}
            value={manualModelName}
            onChange={(event) => setManualModelName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleAddManualModel();
              }
            }}
            disabled={disabled}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleAddManualModel}
            disabled={disabled || !manualModelName.trim()}
          >
            {t('config_management.visual.api_keys.add_model')}
          </Button>
        </div>

        {candidateModelNames.length === 0 ? (
          <div className={styles.emptyState}>
            {loadError
              ? t('config_management.visual.api_keys.models_manual_only')
              : t('config_management.visual.api_keys.no_models_available')}
          </div>
        ) : (
          <div className={styles.apiKeyModelsList}>
            {candidateModelNames.map((modelName) => {
              const enabled = !disabledSet.has(modelName.toLowerCase());
              return (
                <SelectionCheckbox
                  key={modelName}
                  checked={enabled}
                  disabled={disabled}
                  onChange={(value) => handleToggleModel(modelName, value)}
                  className={styles.apiKeyModelItem}
                  labelClassName={styles.apiKeyModelLabel}
                  label={modelName}
                />
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

export const ApiKeysCardEditor = memo(function ApiKeysCardEditor({
  value,
  disabled,
  onChange,
}: {
  value: VisualConfigApiKeyEntry[];
  disabled?: boolean;
  onChange: (nextValue: VisualConfigApiKeyEntry[]) => void;
}) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const apiKeys = useMemo(() => normalizeApiKeyEntries(value), [value]);

  const apiKeyInputId = useId();
  const apiKeyHintId = `${apiKeyInputId}-hint`;
  const apiKeyErrorId = `${apiKeyInputId}-error`;
  const [modalOpen, setModalOpen] = useState(false);
  const [modelsModalOpen, setModelsModalOpen] = useState(false);
  const [editingApiKeyId, setEditingApiKeyId] = useState<string | null>(null);
  const [modelsApiKeyId, setModelsApiKeyId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [formError, setFormError] = useState('');

  function generateSecureApiKey(): string {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const array = new Uint8Array(17);
    crypto.getRandomValues(array);
    return 'sk-' + Array.from(array, (b) => charset[b % charset.length]).join('');
  }

  const openAddModal = () => {
    setEditingApiKeyId(null);
    setInputValue('');
    setFormError('');
    setModalOpen(true);
  };

  const openEditModal = (apiKeyId: string) => {
    const editingIndex = apiKeys.findIndex((entry) => entry.id === apiKeyId);
    setEditingApiKeyId(apiKeyId);
    setInputValue(apiKeys[editingIndex]?.apiKey ?? '');
    setFormError('');
    setModalOpen(true);
  };

  const openModelsModal = (apiKeyId: string) => {
    setModelsApiKeyId(apiKeyId);
    setModelsModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setInputValue('');
    setEditingApiKeyId(null);
    setFormError('');
  };

  const closeModelsModal = () => {
    setModelsModalOpen(false);
    setModelsApiKeyId(null);
  };

  const updateApiKeys = (nextKeys: VisualConfigApiKeyEntry[]) => {
    onChange(normalizeApiKeyEntries(nextKeys));
  };

  const handleDelete = (apiKeyId: string) => {
    const index = apiKeys.findIndex((entry) => entry.id === apiKeyId);
    if (index < 0) return;
    updateApiKeys(apiKeys.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setFormError(t('config_management.visual.api_keys.error_empty'));
      return;
    }
    if (!isValidApiKeyCharset(trimmed)) {
      setFormError(t('config_management.visual.api_keys.error_invalid'));
      return;
    }

    const editingIndex = editingApiKeyId
      ? apiKeys.findIndex((entry) => entry.id === editingApiKeyId)
      : -1;
    const nextKeys: VisualConfigApiKeyEntry[] =
      editingApiKeyId === null
        ? [...apiKeys, { id: makeClientId(), apiKey: trimmed, disabledModels: [] }]
        : apiKeys.map((entry, idx) =>
            idx === editingIndex ? { ...entry, apiKey: trimmed } : entry
          );
    updateApiKeys(nextKeys);
    closeModal();
  };

  const handleCopy = async (apiKey: string) => {
    const copied = await copyToClipboard(apiKey);
    showNotification(
      t(copied ? 'notification.link_copied' : 'notification.copy_failed'),
      copied ? 'success' : 'error'
    );
  };

  const handleGenerate = () => {
    setInputValue(generateSecureApiKey());
    setFormError('');
  };

  const handleSaveDisabledModels = (disabledModels: string[]) => {
    if (!modelsApiKeyId) return;
    updateApiKeys(
      apiKeys.map((entry) =>
        entry.id === modelsApiKeyId ? { ...entry, disabledModels } : entry
      )
    );
  };

  const modelsTargetEntry = apiKeys.find((entry) => entry.id === modelsApiKeyId) ?? null;

  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <div className={styles.blockHeaderRow}>
        <label style={{ margin: 0 }}>{t('config_management.visual.api_keys.label')}</label>
        <Button size="sm" onClick={openAddModal} disabled={disabled}>
          {t('config_management.visual.api_keys.add')}
        </Button>
      </div>

      {apiKeys.length === 0 ? (
        <div className={styles.emptyState}>{t('config_management.visual.api_keys.empty')}</div>
      ) : (
        <div className="item-list" style={{ marginTop: 4 }}>
          {apiKeys.map((entry, index) => (
            <div key={entry.id} className="item-row">
              <div className="item-meta">
                <div className="pill">#{index + 1}</div>
                <div className="item-title">
                  {t('config_management.visual.api_keys.input_label')}
                </div>
                <div className="item-subtitle">{maskApiKey(entry.apiKey)}</div>
                <div className={styles.apiKeyCardMetaRow}>
                  <span className={styles.apiKeyCardMetaLabel}>
                    {entry.disabledModels.length > 0
                      ? t('config_management.visual.api_keys.disabled_models_count', {
                          count: entry.disabledModels.length,
                        })
                      : t('config_management.visual.api_keys.all_models_enabled')}
                  </span>
                </div>
              </div>
              <div className="item-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openModelsModal(entry.id)}
                  disabled={disabled}
                >
                  {t('config_management.visual.api_keys.configure_models')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleCopy(entry.apiKey)}
                  disabled={disabled}
                >
                  {t('common.copy')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openEditModal(entry.id)}
                  disabled={disabled}
                >
                  {t('config_management.visual.common.edit')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => handleDelete(entry.id)}
                  disabled={disabled}
                >
                  {t('config_management.visual.common.delete')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="hint">{t('config_management.visual.api_keys.hint')}</div>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={
          editingApiKeyId !== null
            ? t('config_management.visual.api_keys.edit_title')
            : t('config_management.visual.api_keys.add_title')
        }
        footer={
          <>
            <Button variant="secondary" onClick={closeModal} disabled={disabled}>
              {t('config_management.visual.common.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={disabled}>
              {editingApiKeyId !== null
                ? t('config_management.visual.common.update')
                : t('config_management.visual.common.add')}
            </Button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor={apiKeyInputId}>
            {t('config_management.visual.api_keys.input_label')}
          </label>
          <div className={styles.apiKeyModalInputRow}>
            <input
              id={apiKeyInputId}
              className="input"
              placeholder={t('config_management.visual.api_keys.input_placeholder')}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              disabled={disabled}
              aria-describedby={formError ? `${apiKeyErrorId} ${apiKeyHintId}` : apiKeyHintId}
              aria-invalid={Boolean(formError)}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleGenerate}
              disabled={disabled}
            >
              {t('config_management.visual.api_keys.generate')}
            </Button>
          </div>
          <div id={apiKeyHintId} className="hint">
            {t('config_management.visual.api_keys.input_hint')}
          </div>
          {formError && (
            <div id={apiKeyErrorId} className="error-box">
              {formError}
            </div>
          )}
        </div>
      </Modal>

      <ApiKeyModelsModal
        open={modelsModalOpen}
        apiKeyEntry={modelsTargetEntry}
        disabled={disabled}
        onClose={closeModelsModal}
        onSave={handleSaveDisabledModels}
      />
    </div>
  );
});

const StringListEditor = memo(function StringListEditor({
  value,
  disabled,
  placeholder,
  inputAriaLabel,
  onChange,
}: {
  value: string[];
  disabled?: boolean;
  placeholder?: string;
  inputAriaLabel?: string;
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const items = value.length ? value : [];
  const [itemIds, setItemIds] = useState(() => items.map(() => makeClientId()));
  const renderItemIds = useMemo(() => {
    if (itemIds.length === items.length) return itemIds;
    if (itemIds.length > items.length) return itemIds.slice(0, items.length);
    return [
      ...itemIds,
      ...Array.from({ length: items.length - itemIds.length }, () => makeClientId()),
    ];
  }, [itemIds, items.length]);

  const updateItem = (index: number, nextValue: string) =>
    onChange(items.map((item, i) => (i === index ? nextValue : item)));
  const addItem = () => {
    setItemIds([...renderItemIds, makeClientId()]);
    onChange([...items, '']);
  };
  const removeItem = (index: number) => {
    setItemIds(renderItemIds.filter((_, i) => i !== index));
    onChange(items.filter((_, i) => i !== index));
  };

  return (
    <div className={styles.stringList}>
      {items.map((item, index) => (
        <div key={renderItemIds[index] ?? `item-${index}`} className={styles.stringListRow}>
          <input
            className="input"
            placeholder={placeholder}
            aria-label={inputAriaLabel ?? placeholder}
            value={item}
            onChange={(e) => updateItem(index, e.target.value)}
            disabled={disabled}
            style={{ flex: 1 }}
          />
          <Button variant="ghost" size="sm" onClick={() => removeItem(index)} disabled={disabled}>
            {t('config_management.visual.common.delete')}
          </Button>
        </div>
      ))}
      <div className={styles.actionRow}>
        <Button variant="secondary" size="sm" onClick={addItem} disabled={disabled}>
          {t('config_management.visual.common.add')}
        </Button>
      </div>
    </div>
  );
});

export const PayloadRulesEditor = memo(function PayloadRulesEditor({
  value,
  disabled,
  protocolFirst = false,
  rawJsonValues = false,
  onChange,
}: {
  value: PayloadRule[];
  disabled?: boolean;
  protocolFirst?: boolean;
  rawJsonValues?: boolean;
  onChange: (next: PayloadRule[]) => void;
}) {
  const { t } = useTranslation();
  const rules = value;
  const protocolOptions = useMemo(() => buildProtocolOptions(t, rules), [rules, t]);
  const payloadValueTypeOptions = useMemo(
    () =>
      VISUAL_CONFIG_PAYLOAD_VALUE_TYPE_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey, { defaultValue: option.defaultLabel }),
      })),
    [t]
  );
  const booleanValueOptions = useMemo(
    () => [
      { value: 'true', label: t('config_management.visual.payload_rules.boolean_true') },
      { value: 'false', label: t('config_management.visual.payload_rules.boolean_false') },
    ],
    [t]
  );

  const addRule = () => onChange([...rules, { id: makeClientId(), models: [], params: [] }]);
  const removeRule = (ruleIndex: number) => onChange(rules.filter((_, i) => i !== ruleIndex));

  const updateRule = (ruleIndex: number, patch: Partial<PayloadRule>) =>
    onChange(rules.map((rule, i) => (i === ruleIndex ? { ...rule, ...patch } : rule)));

  const addModel = (ruleIndex: number) => {
    const rule = rules[ruleIndex];
    const nextModel: PayloadModelEntry = { id: makeClientId(), name: '', protocol: undefined };
    updateRule(ruleIndex, { models: [...rule.models, nextModel] });
  };

  const removeModel = (ruleIndex: number, modelIndex: number) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, { models: rule.models.filter((_, i) => i !== modelIndex) });
  };

  const updateModel = (
    ruleIndex: number,
    modelIndex: number,
    patch: Partial<PayloadModelEntry>
  ) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, {
      models: rule.models.map((m, i) => (i === modelIndex ? { ...m, ...patch } : m)),
    });
  };

  const addParam = (ruleIndex: number) => {
    const rule = rules[ruleIndex];
    const nextParam: PayloadParamEntry = {
      id: makeClientId(),
      path: '',
      valueType: rawJsonValues ? 'json' : 'string',
      value: '',
    };
    updateRule(ruleIndex, { params: [...rule.params, nextParam] });
  };

  const removeParam = (ruleIndex: number, paramIndex: number) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, { params: rule.params.filter((_, i) => i !== paramIndex) });
  };

  const updateParam = (
    ruleIndex: number,
    paramIndex: number,
    patch: Partial<PayloadParamEntry>
  ) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, {
      params: rule.params.map((p, i) => (i === paramIndex ? { ...p, ...patch } : p)),
    });
  };

  const getValuePlaceholder = (valueType: PayloadParamValueType) => {
    switch (valueType) {
      case 'string':
        return t('config_management.visual.payload_rules.value_string');
      case 'number':
        return t('config_management.visual.payload_rules.value_number');
      case 'boolean':
        return t('config_management.visual.payload_rules.value_boolean');
      case 'json':
        return t('config_management.visual.payload_rules.value_json');
      default:
        return t('config_management.visual.payload_rules.value_default');
    }
  };

  const getParamErrorMessage = (param: PayloadParamEntry) => {
    const errorCode = getPayloadParamValidationError(
      rawJsonValues ? { ...param, valueType: 'json' } : param
    );
    return getValidationMessage(t, errorCode);
  };

  const renderParamValueEditor = (
    ruleIndex: number,
    paramIndex: number,
    param: PayloadParamEntry
  ) => {
    if (rawJsonValues) {
      return (
        <textarea
          className={`input ${styles.payloadJsonInput}`}
          placeholder={t('config_management.visual.payload_rules.value_raw_json')}
          aria-label={t('config_management.visual.payload_rules.param_value')}
          value={param.value}
          onChange={(e) =>
            updateParam(ruleIndex, paramIndex, { value: e.target.value, valueType: 'json' })
          }
          disabled={disabled}
        />
      );
    }

    if (param.valueType === 'boolean') {
      return (
        <Select
          value={
            param.value.toLowerCase() === 'true' || param.value.toLowerCase() === 'false'
              ? param.value.toLowerCase()
              : ''
          }
          options={booleanValueOptions}
          placeholder={t('config_management.visual.payload_rules.value_boolean')}
          disabled={disabled}
          ariaLabel={t('config_management.visual.payload_rules.param_value')}
          onChange={(nextValue) => updateParam(ruleIndex, paramIndex, { value: nextValue })}
        />
      );
    }

    if (param.valueType === 'json') {
      return (
        <textarea
          className={`input ${styles.payloadJsonInput}`}
          placeholder={getValuePlaceholder(param.valueType)}
          aria-label={t('config_management.visual.payload_rules.param_value')}
          value={param.value}
          onChange={(e) => updateParam(ruleIndex, paramIndex, { value: e.target.value })}
          disabled={disabled}
        />
      );
    }

    return (
      <input
        className="input"
        placeholder={getValuePlaceholder(param.valueType)}
        aria-label={t('config_management.visual.payload_rules.param_value')}
        value={param.value}
        onChange={(e) => updateParam(ruleIndex, paramIndex, { value: e.target.value })}
        disabled={disabled}
      />
    );
  };

  return (
    <div className={styles.blockStack}>
      {rules.map((rule, ruleIndex) => (
        <div key={rule.id} className={styles.ruleCard}>
          <div className={styles.ruleCardHeader}>
            <div className={styles.ruleCardTitle}>
              {t('config_management.visual.payload_rules.rule')} {ruleIndex + 1}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => removeRule(ruleIndex)}
              disabled={disabled}
            >
              {t('config_management.visual.common.delete')}
            </Button>
          </div>

          <div className={styles.blockStack}>
            <div className={styles.blockLabel}>
              {t('config_management.visual.payload_rules.models')}
            </div>
            {(rule.models.length ? rule.models : []).map((model, modelIndex) => (
              <div
                key={model.id}
                className={[
                  styles.payloadRuleModelRow,
                  protocolFirst ? styles.payloadRuleModelRowProtocolFirst : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {protocolFirst ? (
                  <>
                    <Select
                      value={model.protocol ?? ''}
                      options={protocolOptions}
                      disabled={disabled}
                      ariaLabel={t('config_management.visual.payload_rules.provider_type')}
                      onChange={(nextValue) =>
                        updateModel(ruleIndex, modelIndex, {
                          protocol: (nextValue || undefined) as PayloadModelEntry['protocol'],
                        })
                      }
                    />
                    <input
                      className="input"
                      placeholder={t('config_management.visual.payload_rules.model_name')}
                      aria-label={t('config_management.visual.payload_rules.model_name')}
                      value={model.name}
                      onChange={(e) => updateModel(ruleIndex, modelIndex, { name: e.target.value })}
                      disabled={disabled}
                    />
                  </>
                ) : (
                  <>
                    <input
                      className="input"
                      placeholder={t('config_management.visual.payload_rules.model_name')}
                      aria-label={t('config_management.visual.payload_rules.model_name')}
                      value={model.name}
                      onChange={(e) => updateModel(ruleIndex, modelIndex, { name: e.target.value })}
                      disabled={disabled}
                    />
                    <Select
                      value={model.protocol ?? ''}
                      options={protocolOptions}
                      disabled={disabled}
                      ariaLabel={t('config_management.visual.payload_rules.provider_type')}
                      onChange={(nextValue) =>
                        updateModel(ruleIndex, modelIndex, {
                          protocol: (nextValue || undefined) as PayloadModelEntry['protocol'],
                        })
                      }
                    />
                  </>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.payloadRowActionButton}
                  onClick={() => removeModel(ruleIndex, modelIndex)}
                  disabled={disabled}
                >
                  {t('config_management.visual.common.delete')}
                </Button>
              </div>
            ))}
            <div className={styles.actionRow}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => addModel(ruleIndex)}
                disabled={disabled}
              >
                {t('config_management.visual.payload_rules.add_model')}
              </Button>
            </div>
          </div>

          <div className={styles.blockStack}>
            <div className={styles.blockLabel}>
              {t('config_management.visual.payload_rules.params')}
            </div>
            {(rule.params.length ? rule.params : []).map((param, paramIndex) => {
              const paramError = getParamErrorMessage(param);

              return (
                <div key={param.id} className={styles.payloadRuleParamGroup}>
                  <div className={styles.payloadRuleParamRow}>
                    <input
                      className="input"
                      placeholder={t('config_management.visual.payload_rules.json_path')}
                      aria-label={t('config_management.visual.payload_rules.json_path')}
                      value={param.path}
                      onChange={(e) => updateParam(ruleIndex, paramIndex, { path: e.target.value })}
                      disabled={disabled}
                    />
                    {rawJsonValues ? null : (
                      <Select
                        value={param.valueType}
                        options={payloadValueTypeOptions}
                        disabled={disabled}
                        ariaLabel={t('config_management.visual.payload_rules.param_type')}
                        onChange={(nextValue) =>
                          updateParam(ruleIndex, paramIndex, {
                            valueType: nextValue as PayloadParamValueType,
                            value:
                              nextValue === 'boolean'
                                ? 'true'
                                : nextValue === 'json' && param.value.trim() === ''
                                  ? '{}'
                                  : param.value,
                          })
                        }
                      />
                    )}
                    {renderParamValueEditor(ruleIndex, paramIndex, param)}
                    <Button
                      variant="ghost"
                      size="sm"
                      className={styles.payloadRowActionButton}
                      onClick={() => removeParam(ruleIndex, paramIndex)}
                      disabled={disabled}
                    >
                      {t('config_management.visual.common.delete')}
                    </Button>
                  </div>
                  {paramError && (
                    <div className={`error-box ${styles.payloadParamError}`}>{paramError}</div>
                  )}
                </div>
              );
            })}
            <div className={styles.actionRow}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => addParam(ruleIndex)}
                disabled={disabled}
              >
                {t('config_management.visual.payload_rules.add_param')}
              </Button>
            </div>
          </div>
        </div>
      ))}

      {rules.length === 0 && (
        <div className={styles.emptyState}>
          {t('config_management.visual.payload_rules.no_rules')}
        </div>
      )}

      <div className={styles.actionRow}>
        <Button variant="secondary" size="sm" onClick={addRule} disabled={disabled}>
          {t('config_management.visual.payload_rules.add_rule')}
        </Button>
      </div>
    </div>
  );
});

export const PayloadFilterRulesEditor = memo(function PayloadFilterRulesEditor({
  value,
  disabled,
  onChange,
}: {
  value: PayloadFilterRule[];
  disabled?: boolean;
  onChange: (next: PayloadFilterRule[]) => void;
}) {
  const { t } = useTranslation();
  const rules = value;
  const protocolOptions = useMemo(() => buildProtocolOptions(t, rules), [rules, t]);

  const addRule = () => onChange([...rules, { id: makeClientId(), models: [], params: [] }]);
  const removeRule = (ruleIndex: number) => onChange(rules.filter((_, i) => i !== ruleIndex));

  const updateRule = (ruleIndex: number, patch: Partial<PayloadFilterRule>) =>
    onChange(rules.map((rule, i) => (i === ruleIndex ? { ...rule, ...patch } : rule)));

  const addModel = (ruleIndex: number) => {
    const rule = rules[ruleIndex];
    const nextModel: PayloadModelEntry = { id: makeClientId(), name: '', protocol: undefined };
    updateRule(ruleIndex, { models: [...rule.models, nextModel] });
  };

  const removeModel = (ruleIndex: number, modelIndex: number) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, { models: rule.models.filter((_, i) => i !== modelIndex) });
  };

  const updateModel = (
    ruleIndex: number,
    modelIndex: number,
    patch: Partial<PayloadModelEntry>
  ) => {
    const rule = rules[ruleIndex];
    updateRule(ruleIndex, {
      models: rule.models.map((m, i) => (i === modelIndex ? { ...m, ...patch } : m)),
    });
  };

  return (
    <div className={styles.blockStack}>
      {rules.map((rule, ruleIndex) => (
        <div key={rule.id} className={styles.ruleCard}>
          <div className={styles.ruleCardHeader}>
            <div className={styles.ruleCardTitle}>
              {t('config_management.visual.payload_rules.rule')} {ruleIndex + 1}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => removeRule(ruleIndex)}
              disabled={disabled}
            >
              {t('config_management.visual.common.delete')}
            </Button>
          </div>

          <div className={styles.blockStack}>
            <div className={styles.blockLabel}>
              {t('config_management.visual.payload_rules.models')}
            </div>
            {rule.models.map((model, modelIndex) => (
              <div key={model.id} className={styles.payloadFilterModelRow}>
                <input
                  className="input"
                  placeholder={t('config_management.visual.payload_rules.model_name')}
                  aria-label={t('config_management.visual.payload_rules.model_name')}
                  value={model.name}
                  onChange={(e) => updateModel(ruleIndex, modelIndex, { name: e.target.value })}
                  disabled={disabled}
                />
                <Select
                  value={model.protocol ?? ''}
                  options={protocolOptions}
                  disabled={disabled}
                  ariaLabel={t('config_management.visual.payload_rules.provider_type')}
                  onChange={(nextValue) =>
                    updateModel(ruleIndex, modelIndex, {
                      protocol: (nextValue || undefined) as PayloadModelEntry['protocol'],
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.payloadRowActionButton}
                  onClick={() => removeModel(ruleIndex, modelIndex)}
                  disabled={disabled}
                >
                  {t('config_management.visual.common.delete')}
                </Button>
              </div>
            ))}
            <div className={styles.actionRow}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => addModel(ruleIndex)}
                disabled={disabled}
              >
                {t('config_management.visual.payload_rules.add_model')}
              </Button>
            </div>
          </div>

          <div className={styles.blockStack}>
            <div className={styles.blockLabel}>
              {t('config_management.visual.payload_rules.remove_params')}
            </div>
            <StringListEditor
              value={rule.params}
              disabled={disabled}
              placeholder={t('config_management.visual.payload_rules.json_path_filter')}
              inputAriaLabel={t('config_management.visual.payload_rules.json_path_filter')}
              onChange={(params) => updateRule(ruleIndex, { params })}
            />
          </div>
        </div>
      ))}

      {rules.length === 0 && (
        <div className={styles.emptyState}>
          {t('config_management.visual.payload_rules.no_rules')}
        </div>
      )}

      <div className={styles.actionRow}>
        <Button variant="secondary" size="sm" onClick={addRule} disabled={disabled}>
          {t('config_management.visual.payload_rules.add_rule')}
        </Button>
      </div>
    </div>
  );
});
