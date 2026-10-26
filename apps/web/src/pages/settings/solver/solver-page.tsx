import { useId, useState } from 'react';
import type { ProxyAutoDetectResult, SolverSettings, SolverStatus } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { solverApi, type SolverTestResponse } from '../../../api/solver.js';
import { Button, ErrorBlock, FormRow, Input, KeyValue, LiveDot, Pane, Skeleton, Toggle, type KeyValueItem } from '../../../arclight/index.js';
import { useInvalidatingMutation } from '../../../hooks/settings-keys.js';
import { solverKeys, useSolverSettings, useSolverStatus } from '../../../hooks/updates.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { SettingsSection } from '../shared.js';
import '../vpn.css';
import './solver.css';
import { t } from '../../../i18n/index.js';

export const SOLVER_DOCS_URL = 'https://github.com/arclight/arclight/blob/main/docs/CLOUDFLARE.md';
export const SOLVER_TEST_URL = 'https://example.com/';

/** "Ready", "Solving · 2 queued", "No browser found", "Off". */
export function solverStatusText(status: SolverStatus | undefined): { text: string; tone: 'ok' | 'warn' | 'off' } {
  if (!status || !status.enabled) return { text: t('common.off'), tone: 'off' };
  if (!status.browser) return { text: t('settings.solver.noBrowserFoundInstallEdge'), tone: 'warn' };
  if (status.pending > 0) return { text: t('settings.solver.solvingRequestsInProgress', { pending: status.pending }), tone: 'ok' };
  return { text: status.running ? t('settings.solver.readyBrowserRunning') : t('settings.solver.readyBrowserStartsOnFirst'), tone: 'ok' };
}

export function solverStatusItems(status: SolverStatus): KeyValueItem[] {
  return [
    { label: t('settings.solver.browser'), value: status.browser?.name ?? 'none found', mono: false },
    { label: t('common.path'), value: status.browser?.path ?? '—' },
    { label: t('common.running'), value: status.running ? 'yes' : 'no' },
    { label: t('common.queue'), value: String(status.pending) },
    { label: t('settings.solver.proxy'), value: status.proxyId === null ? 'not registered' : t('settings.solver.builtInSolverProxyid', { proxyId: status.proxyId }) },
    { label: t('common.profile'), value: status.profileDir },
  ];
}

/** One line for the Test result: "Solved in 4.2 s · HTTP 200" or the solver's error. */
export function solverTestText(result: { response: SolverTestResponse; elapsedMs: number }): { ok: boolean; text: string } {
  const secs = `${(result.elapsedMs / 1000).toFixed(1)} s`;
  if (result.response.status === 'ok') {
    const http = result.response.solution?.status;
    return { ok: true, text: t('settings.solver.solvedSolverTestUrlIn', { SOLVER_TEST_URL, secs, value: http ? ` · HTTP ${http}` : '' }) };
  }
  return { ok: false, text: t('settings.solver.failedAfterSecsValue', { secs, value: result.response.message ?? 'unknown error' }) };
}

function StatusPane() {
  const status = useSolverStatus();
  const [detected, setDetected] = useState<ProxyAutoDetectResult | null>(null);
  const detect = useInvalidatingMutation(() => solverApi.autodetect(), [solverKeys.status], { errorTitle: t('settings.solver.detectionFailed') });
  const s = solverStatusText(status.data);
  return (
    <Pane
      chamfer="tl"
      title={t('common.liveStatus')}
      aria-label={t('common.liveStatus')}
      actions={
        <Button size="sm" variant="ghost" loading={detect.isPending} onClick={() => detect.mutate(undefined, { onSuccess: setDetected })}>
          {t('settings.solver.detectNow')}
        </Button>
      }
    >
      {status.isPending ? (
        <Skeleton lines={4} />
      ) : status.isError ? (
        <ErrorBlock title={t('settings.solver.couldntReadTheSolverStatus')} onRetry={() => void status.refetch()}>
          {errorMessage(status.error)}
        </ErrorBlock>
      ) : (
        <div className="al-vpn-status">
          <p className="al-vpn-status__line" data-tone={s.tone === 'ok' ? undefined : s.tone} role="status">
            {s.tone === 'ok' && status.data.pending > 0 ? <LiveDot /> : null}
            <span>{s.text}</span>
          </p>
          <KeyValue items={solverStatusItems(status.data)} />
          {detected ? (
            <p className="al-caption al-solver-detect" role="note">
              {detected.messages.length ? detected.messages.join(' · ') : t('settings.solver.detectionRanNoProxyChanges')}
            </p>
          ) : null}
        </div>
      )}
    </Pane>
  );
}

function SolverForm({ data }: { data: SolverSettings }) {
  const draft = useDraft(data);
  const save = useInvalidatingMutation((body: SolverSettings) => solverApi.settings.update(body), [solverKeys.settings, solverKeys.status], {
    errorTitle: t('settings.solver.couldNotSaveSolverSettings'),
  });
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const ids = { enabled: useId(), path: useId(), timeout: useId(), idle: useId() };
  const v = draft.value;
  const set = <K extends keyof SolverSettings>(k: K, value: SolverSettings[K]) => draft.set((d) => ({ ...d, [k]: value }));

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(solverTestText(await solverApi.test(SOLVER_TEST_URL, v.timeoutSeconds * 1000)));
    } catch (err) {
      setTest({ ok: false, text: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsPage
      title={t('common.challengeSolver')}
      description={
        <>
          {t('settings.solver.solvesCloudflareAndDdosGuard')}
          <a className="al-link" href={SOLVER_DOCS_URL} target="_blank" rel="noreferrer">
            {t('settings.solver.howItWorks')}
          </a>
        </>
      }
      actions={
        <Button size="sm" loading={testing} onClick={() => void runTest()}>
          {t('common.test')}
        </Button>
      }
      save={{ count: draft.changes, onSave: () => save.mutate(v), onDiscard: draft.discard, saving: save.isPending }}
      aside={<StatusPane />}
      after={
        test ? (
          <Pane title={t('common.testResult')} aria-label={t('common.testResult')}>
            <p className="al-vpn-status__line" data-tone={test.ok ? undefined : 'danger'} role="status">
              {test.text}
            </p>
          </Pane>
        ) : null
      }
    >
      <SettingsSection label={t('settings.solver.builtInSolver')}>
        <div className="al-vpn-rows">
          <FormRow label={t('settings.solver.solver')} htmlFor={ids.enabled} captionInline>
            <Toggle id={ids.enabled} checked={v.enabled} label={t('settings.solver.useALocalBrowserTo')} onChange={(e) => set('enabled', e.currentTarget.checked)} />
          </FormRow>
          <FormRow label={t('settings.solver.browserPath')} htmlFor={ids.path} caption={t('settings.solver.leaveEmptyToFindEdge')}>
            <Input
              id={ids.path}
              mono
              spellCheck={false}
              placeholder="auto-detect"
              value={v.browserPath ?? ''}
              onChange={(e) => {
                const path = e.currentTarget.value;
                draft.set((d) => {
                  const { browserPath: _drop, ...rest } = d;
                  return path.trim() ? { ...rest, browserPath: path } : rest;
                });
              }}
            />
          </FormRow>
          <FormRow label={t('settings.solver.timeout')} htmlFor={ids.timeout} caption={t('settings.solver.giveUpOnAChallenge')}>
            <Input id={ids.timeout} type="number" mono min={5} max={300} end="s" className="al-vpn-num" value={v.timeoutSeconds} onChange={(e) => set('timeoutSeconds', Number(e.currentTarget.value))} />
          </FormRow>
          <FormRow label={t('settings.solver.closeWhenIdle')} htmlFor={ids.idle} caption={t('settings.solver.closeTheBrowserAfterThis')}>
            <Input id={ids.idle} type="number" mono min={0} max={86400} end="s" className="al-vpn-num" value={v.idleCloseSeconds} onChange={(e) => set('idleCloseSeconds', Number(e.currentTarget.value))} />
          </FormRow>
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}

/** Settings → Challenge solver (/settings/solver). */
export function SolverSettingsPage() {
  const settings = useSolverSettings();
  if (settings.isSuccess) return <SolverForm data={settings.data} />;
  return (
    <SettingsPage title={t('common.challengeSolver')} aside={<StatusPane />}>
      {settings.isError ? (
        <ErrorBlock title={t('settings.solver.couldntLoadSolverSettings')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : (
        <Skeleton lines={5} />
      )}
    </SettingsPage>
  );
}
