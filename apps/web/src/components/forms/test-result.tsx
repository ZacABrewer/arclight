import { useState } from 'react';
import { errorMessage } from '../../api/client.js';
import { Button } from '../button.js';

/** Normalized answer of any `/test` route (download client, indexer, notification). */
export interface TestOutcome {
  ok: boolean;
  message?: string | undefined;
  warnings: string[];
  errors: string[];
}

export function TestResultView({ outcome }: { outcome: TestOutcome }) {
  return (
    <div className={`test-result ${outcome.ok ? 'test-result-ok' : 'test-result-error'}`} role="status">
      <strong>{outcome.ok ? 'Test passed' : 'Test failed'}</strong>
      {outcome.message ? <span className="muted"> · {outcome.message}</span> : null}
      {outcome.errors.length > 0 ? (
        <ul className="test-result-list test-result-errors">
          {outcome.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {outcome.warnings.length > 0 ? (
        <ul className="test-result-list test-result-warnings">
          {outcome.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export interface TestButtonProps {
  /** Runs the test; a thrown error is shown as a failed outcome. */
  onTest: () => Promise<TestOutcome>;
  /** Return false to block the request (e.g. the form is invalid). */
  beforeTest?: () => boolean;
  disabled?: boolean;
  label?: string;
}

/** A Test button with its result rendered inline next to it. */
export function TestButton({ onTest, beforeTest, disabled, label = 'Test' }: TestButtonProps) {
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);

  const run = async () => {
    if (beforeTest && !beforeTest()) return;
    setRunning(true);
    setOutcome(null);
    try {
      setOutcome(await onTest());
    } catch (err) {
      setOutcome({ ok: false, warnings: [], errors: [errorMessage(err)] });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="test-box">
      <Button onClick={() => void run()} loading={running} disabled={disabled}>
        {label}
      </Button>
      {outcome ? <TestResultView outcome={outcome} /> : null}
    </div>
  );
}
