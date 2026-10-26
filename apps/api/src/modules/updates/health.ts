import { finding, type HealthCheckDef } from '../health/types.js';
import type { ContainerUpdater } from './containers.js';
import type { UpdatesService } from './service.js';

/** Docs anchor of the UpdateAvailable finding (apps/web health docs page). */
export const UPDATE_AVAILABLE_ANCHOR = 'update-available';

/**
 * Health check `UpdateAvailable`: a warning while a newer version is published and the
 * `updates.notifyOnUpdate` setting is on; nothing otherwise. Reads the cached check only.
 */
export function createUpdateAvailableCheck(service: () => UpdatesService): HealthCheckDef {
  return {
    id: 'UpdateAvailable',
    async run() {
      const svc = service();
      const s = svc.settings();
      if (!s.enabled || !s.notifyOnUpdate) return [];
      const info = svc.info();
      if (!info.updateAvailable || !info.latestVersion) return [];
      const how = info.isDocker ? `pull ${info.image ?? 'the image'}:${info.imageTag ?? 'latest'}` : 'install the new release';
      return [
        finding(
          'UpdateAvailable',
          'warning',
          `Arclight ${info.latestVersion} is available (running ${info.currentVersion}). See System > Updates, then ${how}`,
          UPDATE_AVAILABLE_ANCHOR,
        ),
      ];
    },
  };
}

export const CONTAINER_UPDATES_ANCHOR = 'container-updates-available';

/** Health check `ContainerUpdatesAvailable`: labelled containers whose registry image moved on. */
export function createContainerUpdatesCheck(service: () => UpdatesService, containers: () => ContainerUpdater): HealthCheckDef {
  return {
    id: 'ContainerUpdatesAvailable',
    async run() {
      const s = service().settings();
      if (!s.enabled || !s.notifyOnUpdate) return [];
      const pending = containers()
        .cachedContainers()
        .filter((c) => c.updateAvailable)
        .map((c) => c.name);
      if (pending.length === 0) return [];
      const w = s.autoUpdateWindow;
      const pad = (h: number) => `${String(h).padStart(2, '0')}:00`;
      const next =
        s.mode === 'auto'
          ? `They are updated automatically between ${pad(w.startHour)} and ${pad(w.endHour)}.`
          : 'Update them under Settings > Updates.';
      return [finding('ContainerUpdatesAvailable', 'warning', `Container updates available: ${pending.join(', ')}. ${next}`, CONTAINER_UPDATES_ANCHOR)];
    },
  };
}
