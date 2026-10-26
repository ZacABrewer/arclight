import { useState } from 'react';
import { errorMessage } from '../../api/client.js';
import { Button, Chip } from '../../arclight/index.js';
import './forms.css';

/** Normalized answer of any `/test` route (download client, indexer, notification). */
export interface TestOutcome {
  ok: boolean;
  message?: string | undefined;
  warnings: string[];
  errors: string[];
}

/** Inline result next to a Test button: a chip with the verdict, then the causes as lines. */
export function TestResultView({ outcome }: { outcome: TestOutcome }) {
  return (
    <div className="al-test-result" role="status" data-ok={outcome.ok}>
      <div className="al-test-result__head">
        <Chip tone={outcome.ok ? 'accent' : 'danger'}>{outcome.ok ? 'Test passed' : 'Test failed'}</Chip>
        {outcome.message ? <span className="al-test-result__message">{outcome.message}</span> : null}
      </div>
      {outcome.errors.length > 0 ? (
        <ul className="al-test-result__list" data-tone="danger">
          {outcome.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {outcome.warnings.length > 0 ? (
        <ul className="al-test-result__list" data-tone="warn">
          {outcome.warnings.map((w) => (
            <li key={w}>{w}</li>
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
  size?: 'sm' | 'md';
}

/** A secondary Test button with its result rendered inline beside it. */
export function TestButton({ onTest, beforeTest, disabled, label = 'Test', size = 'md' }: TestButtonProps) {
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
    <div className="al-test-box">
      <Button variant="secondary" size={size} onClick={() => void run()} loading={running} disabled={disabled}>
        {label}
      </Button>
      {outcome ? <TestResultView outcome={outcome} /> : null}
    </div>
  );
}
