import { describe, expect, it } from 'vitest';
import { DeleteMediaFileQuery, DeleteMediaQuery } from '@arclight/shared';

// Query strings carry booleans as text. "false" must stay false: the web always sends
// `?deleteFiles=false&addExclusion=false` when the boxes are unticked.
describe('query-string flags', () => {
  it('reads "false" as false and "true" as true', () => {
    expect(DeleteMediaQuery.parse({ deleteFiles: 'false', addExclusion: 'false' })).toEqual({ deleteFiles: false, addExclusion: false });
    expect(DeleteMediaQuery.parse({ deleteFiles: 'true', addExclusion: '1' })).toEqual({ deleteFiles: true, addExclusion: true });
    expect(DeleteMediaQuery.parse({})).toEqual({ deleteFiles: false, addExclusion: false });
    expect(DeleteMediaFileQuery.parse({ deleteFromDisk: 'false' })).toEqual({ deleteFromDisk: false });
    expect(DeleteMediaFileQuery.parse({})).toEqual({ deleteFromDisk: true });
  });

  it('rejects text that is not a boolean', () => {
    expect(DeleteMediaQuery.safeParse({ deleteFiles: 'maybe' }).success).toBe(false);
  });
});
