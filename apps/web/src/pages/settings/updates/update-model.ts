import type { ContainerUpdateItem, UpdateInfo, UpdateWindow } from '@arclight/shared';
import { t } from '../../../i18n/index.js';

// Pure helpers for the Updates screens (System → Updates, Settings → Updates).

export interface HowToUpdate {
  id: 'docker' | 'native';
  title: string;
  /** This is how this instance runs. */
  current: boolean;
  steps: Array<{ text: string; command?: string }>;
}

/** Update instructions for each deployment, the running one first. */
export function howToUpdate(info: Pick<UpdateInfo, 'isDocker' | 'image' | 'imageTag' | 'channel' | 'latestVersion' | 'releases' | 'repo'>): HowToUpdate[] {
  const image = info.image ?? 'ghcr.io/arclight/arclight';
  const tag = info.imageTag ?? (info.channel === 'develop' ? 'develop' : 'latest');
  const docker: HowToUpdate = {
    id: 'docker',
    title: t('settings.updates.update.dockerCompose'),
    current: info.isDocker,
    steps: [
      { text: t('settings.updates.update.backUpConfigFirstDatabase') },
      { text: t('settings.updates.update.pullTheImageAndRecreate'), command: 'docker compose pull arclight && docker compose up -d arclight' },
      { text: t('settings.updates.update.toPinThisVersionInstead', { value: info.channel === 'develop' ? 'develop' : 'latest' }), command: `ARCLIGHT_IMAGE=${image}:${tag}` },
      { text: t('settings.updates.update.orMountTheDockerSocket') },
    ],
  };
  const release = info.releases.find((r) => r.version === info.latestVersion);
  const native: HowToUpdate = {
    id: 'native',
    title: t('settings.updates.update.windowsNativeInstall'),
    current: !info.isDocker,
    steps: [
      { text: t('settings.updates.update.downloadValueFromGithub', { value: info.latestVersion ? `Arclight ${info.latestVersion}` : 'the latest release' }), command: release?.url ?? `https://github.com/${info.repo}/releases/latest` },
      { text: t('settings.updates.update.stopArclightReplaceTheProgram') },
    ],
  };
  return info.isDocker ? [docker, native] : [native, docker];
}

/** "03:00–06:00" (local time). */
export function windowLabel(w: UpdateWindow): string {
  const h = (n: number) => `${String(n).padStart(2, '0')}:00`;
  return w.startHour === w.endHour ? t('settings.updates.update.anyTime') : `${h(w.startHour)}–${h(w.endHour)}`;
}

/** `sha256:0123456789ab…` → `0123456789ab`. */
export function shortDigest(d: string | undefined): string {
  if (!d) return '—';
  return d.replace(/^sha256:/, '').slice(0, 12);
}

export function containerState(c: ContainerUpdateItem): { label: string; tone: 'accent' | 'warn' | 'danger' | 'muted' } {
  if (c.error) return { label: c.error.startsWith('Pinned') || c.error.startsWith('Built locally') ? t('settings.updates.update.notUpdatable') : t('settings.updates.update.checkFailed'), tone: c.error.startsWith('Pinned') || c.error.startsWith('Built locally') ? 'muted' : 'danger' };
  if (c.updateAvailable) return { label: t('settings.updates.update.updateAvailable'), tone: 'warn' };
  return { label: t('common.upToDate'), tone: 'accent' };
}

export const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));
