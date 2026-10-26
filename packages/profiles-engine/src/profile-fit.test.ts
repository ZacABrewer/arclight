import { describe, expect, it } from 'vitest';
import { QUALITIES, type QualityDefinition, type QualityModel, type QualityProfile } from '@arclight/shared';
import { buildItems, fileFit, isStrictlyBetter, violatesProfile } from './index.js';

const qm = (q: QualityDefinition, rev: Partial<QualityModel['revision']> = {}): QualityModel => ({
  quality: { ...q, mediaTypes: [...q.mediaTypes] },
  revision: { version: 1, real: 0, isRepack: false, ...rev },
});

/** WEBDL-720p < HDTV-1080p < WEB-1080p < Bluray-1080p (cutoff); 2160p listed but not allowed. */
const hd1080: QualityProfile = {
  id: 1,
  name: 'HD-1080p',
  upgradeAllowed: true,
  cutoff: QUALITIES['Bluray-1080p'].id,
  items: buildItems(['WEBDL-720p', 'HDTV-1080p', 'WEBDL-1080p', 'WEBRip-1080p', 'Bluray-1080p']),
  minFormatScore: 0,
  cutoffFormatScore: 50,
  minUpgradeFormatScore: 1,
  formatItems: [],
  languages: [],
};

describe('fileFit', () => {
  it('meets the profile at the cutoff with the format cutoff reached', () => {
    expect(fileFit(hd1080, qm(QUALITIES['Bluray-1080p']), 50)).toEqual({ status: 'meets', reasons: [] });
  });

  it('allows upgrades below the quality cutoff', () => {
    expect(fileFit(hd1080, qm(QUALITIES['WEBDL-1080p']), 50)).toEqual({ status: 'upgradeAllowed', reasons: ['belowQualityCutoff'] });
  });

  it('allows upgrades below the format cutoff', () => {
    expect(fileFit(hd1080, qm(QUALITIES['Bluray-1080p']), 10)).toEqual({ status: 'upgradeAllowed', reasons: ['belowFormatCutoff'] });
  });

  it('rejects a quality the profile does not allow, even one ranked above the cutoff', () => {
    expect(fileFit(hd1080, qm(QUALITIES['Bluray-2160p']), 100)).toEqual({ status: 'notAllowed', reasons: ['qualityNotAllowed'] });
    expect(fileFit(hd1080, qm(QUALITIES['SDTV']), 100).status).toBe('notAllowed');
  });

  it('rejects a score below the minimum', () => {
    expect(fileFit(hd1080, qm(QUALITIES['Bluray-1080p']), -1)).toEqual({ status: 'notAllowed', reasons: ['belowMinFormatScore'] });
    expect(violatesProfile(hd1080, qm(QUALITIES['Bluray-1080p']), -1)).toBe(true);
    expect(violatesProfile(hd1080, qm(QUALITIES['Bluray-1080p']), 0)).toBe(false);
  });

  it('treats every allowed quality as meeting a profile with upgrades off', () => {
    const p = { ...hd1080, upgradeAllowed: false };
    expect(fileFit(p, qm(QUALITIES['WEBDL-720p']), 0).status).toBe('meets');
  });
});

describe('isStrictlyBetter', () => {
  const at = (q: QualityDefinition, formatScore = 0, rev = {}) => ({ quality: qm(q, rev), formatScore });

  it('ranks by the profile order', () => {
    expect(isStrictlyBetter(hd1080, at(QUALITIES['HDTV-1080p']), at(QUALITIES['Bluray-1080p']))).toBe(true);
    expect(isStrictlyBetter(hd1080, at(QUALITIES['Bluray-1080p']), at(QUALITIES['HDTV-1080p']))).toBe(false);
  });

  it('never calls a lower position better, even when the current file is not allowed', () => {
    expect(isStrictlyBetter(hd1080, at(QUALITIES['Bluray-2160p']), at(QUALITIES['Bluray-1080p']))).toBe(false);
  });

  it('breaks quality ties on revision, then score', () => {
    expect(isStrictlyBetter(hd1080, at(QUALITIES['WEBDL-1080p']), at(QUALITIES['WEBDL-1080p'], 0, { version: 2 }))).toBe(true);
    expect(isStrictlyBetter(hd1080, at(QUALITIES['WEBDL-1080p'], 10), at(QUALITIES['WEBDL-1080p'], 20))).toBe(true);
    expect(isStrictlyBetter(hd1080, at(QUALITIES['WEBDL-1080p'], 20), at(QUALITIES['WEBDL-1080p'], 20))).toBe(false);
  });
});
