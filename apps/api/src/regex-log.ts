import { describeRegexProblem, setUnsafeRegexListener } from '@arclight/shared';

interface WarnLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Send "stored regex disabled" warnings to the API logger instead of the console. */
export function routeUnsafeRegexWarnings(log: WarnLogger): void {
  setUnsafeRegexListener(({ pattern, problem, where }) => {
    log.warn(
      { component: 'regex', where, problem: describeRegexProblem(problem), pattern: pattern.slice(0, 120) },
      'stored regex pattern disabled',
    );
  });
}
