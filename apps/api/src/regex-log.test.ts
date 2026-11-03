import { describe, expect, it } from 'vitest';
import { regexPatternProblem, reportUnsafeRegex } from '@arclight/shared';
import { routeUnsafeRegexWarnings } from './regex-log.js';

describe('unsafe regex warnings', () => {
  it('go to the API logger', () => {
    const seen: Array<Record<string, unknown>> = [];
    routeUnsafeRegexWarnings({ warn: (obj) => seen.push(obj) });
    const pattern = '(a+)+$';
    const problem = regexPatternProblem(pattern);
    expect(problem).not.toBeNull();
    reportUnsafeRegex(pattern, problem!, 'custom format');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ component: 'regex', where: 'custom format', pattern });
  });
});
