import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import type { DisableState } from '@/hooks/useDisableModel';

interface DisableModelModalProps {
  disableState: DisableState | null;
  disabling: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DisableModelModal({
  disableState,
  disabling,
  onConfirm,
  onCancel,
}: DisableModelModalProps) {
  const { t } = useTranslation();
  const isRestore = disableState?.action === 'restore';

  return (
    <Modal
      open={!!disableState}
      onClose={onCancel}
      title={
        isRestore
          ? t('monitor.credential_restore_title', { defaultValue: '确认恢复凭证' })
          : t('monitor.credential_disable_title', { defaultValue: '确认禁用凭证' })
      }
      width={400}
    >
      <div style={{ padding: '16px 0' }}>
        {disableState ? (
          <p style={{ marginBottom: 16, lineHeight: 1.6 }}>
            {isRestore
              ? t('monitor.credential_restore_confirm', {
                  defaultValue: '确定要恢复当前 key/凭证吗？',
                })
              : t('monitor.credential_disable_confirm', {
                  defaultValue: '确定要禁用当前 key/凭证吗？',
                })}
            <br />
            <strong>{disableState.displayName}</strong>
          </p>
        ) : null}

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onCancel} disabled={disabling}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={disabling}>
            {disabling
              ? t('monitor.credential_updating', { defaultValue: '处理中...' })
              : isRestore
                ? t('monitor.credential_restore_button', { defaultValue: '恢复' })
                : t('monitor.logs.disable', { defaultValue: '禁用' })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
