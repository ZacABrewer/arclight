import { describe, expect, it } from 'vitest';
import { lockMessageMinutes } from './use-pick';

describe('lockMessageMinutes', () => {
  it('rounds up to whole minutes, at least one', () => {
    expect(lockMessageMinutes(900)).toBe(15);
    expect(lockMessageMinutes(61)).toBe(2);
    expect(lockMessageMinutes(0)).toBe(1);
  });
});
