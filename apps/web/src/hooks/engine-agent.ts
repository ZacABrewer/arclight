import { useQuery } from '@tanstack/react-query';
import type { EngineAgentSettingsUpdate } from '@arclight/shared';
import { engineAgentApi } from '../api/engine-agent.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

export const engineAgentKeys = { settings: ['settings', 'engineagent'] as const };

export function useEngineAgentSettings() {
  return useQuery({ queryKey: engineAgentKeys.settings, queryFn: engineAgentApi.get, retry: false });
}

export function useSaveEngineAgentSettings() {
  return useInvalidatingMutation((body: EngineAgentSettingsUpdate) => engineAgentApi.update(body), [engineAgentKeys.settings], {
    errorTitle: t('hooks.engineAgent.couldNotSaveRemoteEngine'),
  });
}
