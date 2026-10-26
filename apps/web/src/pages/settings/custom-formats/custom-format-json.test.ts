import { describe, expect, it } from 'vitest';
import { exportCustomFormat, normalizeFields, parseCustomFormatJson } from './custom-format-json.js';

// Shape of a TRaSH-guides custom format file (values are illustrative fixture data).
const trash = {
  trash_id: 'abc',
  name: 'x265 (HD)',
  includeCustomFormatWhenRenaming: true,
  specifications: [
    { name: 'x265', implementation: 'ReleaseTitleSpecification', negate: false, required: true, fields: { value: '[xh][ .]?265|\\bHEVC(\\b|\\d)' } },
    { name: 'Not 2160p', implementation: 'ResolutionSpecification', negate: true, required: true, fields: { value: 2160 } },
  ],
};

describe('custom format JSON import', () => {
  it('maps a TRaSH-style format with object fields', () => {
    const { formats, warnings } = parseCustomFormatJson(JSON.stringify(trash));
    expect(warnings).toEqual([]);
    expect(formats).toEqual([
      {
        name: 'x265 (HD)',
        includeWhenRenaming: true,
        specifications: [
          { implementation: 'releaseTitle', name: 'x265', negate: false, required: true, fields: { pattern: '[xh][ .]?265|\\bHEVC(\\b|\\d)' } },
          { implementation: 'resolution', name: 'Not 2160p', negate: true, required: true, fields: { resolution: 2160 } },
        ],
      },
    ]);
  });

  it('accepts the *arr API array form of fields', () => {
    expect(normalizeFields([{ name: 'value', value: 3 }, { name: 'exceptLanguage', value: true }])).toEqual({ value: 3, exceptLanguage: true });
    const json = JSON.stringify({
      name: 'Not French',
      specifications: [{ name: 'French', implementation: 'LanguageSpecification', negate: true, required: false, fields: [{ name: 'value', value: 2 }] }],
    });
    const { formats } = parseCustomFormatJson(json);
    expect(formats[0]?.specifications[0]).toEqual({
      implementation: 'language',
      name: 'French',
      negate: true,
      required: false,
      fields: { language: 'fr', exceptLanguage: false },
    });
    expect(formats[0]?.includeWhenRenaming).toBe(false);
  });

  it('maps numeric sources per source app', () => {
    const json = JSON.stringify({ name: 'WEB', specifications: [{ name: 'WEB', implementation: 'SourceSpecification', fields: { value: 7 } }] });
    expect(parseCustomFormatJson(json, 'sonarr').formats[0]?.specifications[0]).toMatchObject({ fields: { source: 'blurayRaw' } });
    expect(parseCustomFormatJson(json, 'radarr').formats[0]?.specifications[0]).toMatchObject({ fields: { source: 'web' } });
  });

  it('maps size, year, release type and quality modifier specs', () => {
    const json = JSON.stringify({
      name: 'Mixed',
      specifications: [
        { name: 'Size', implementation: 'SizeSpecification', fields: { min: 1, max: 10 } },
        { name: 'Year', implementation: 'YearSpecification', fields: { min: 1990, max: 1999 } },
        { name: 'Pack', implementation: 'ReleaseTypeSpecification', fields: { value: 3 } },
        { name: 'Remux', implementation: 'QualityModifierSpecification', fields: { value: 5 } },
      ],
    });
    const specs = parseCustomFormatJson(json).formats[0]!.specifications;
    expect(specs.map((s) => s.fields)).toEqual([
      { minGb: 1, maxGb: 10 },
      { min: 1990, max: 1999 },
      { releaseType: 'seasonPack' },
      { modifier: 'remux' },
    ]);
  });

  it('skips unsupported or invalid specs with a warning and keeps the rest', () => {
    const json = JSON.stringify({
      name: 'Partial',
      specifications: [
        { name: 'Weird', implementation: 'MadeUpSpecification', fields: { value: 1 } },
        { name: 'Empty regex', implementation: 'ReleaseTitleSpecification', fields: { value: '' } },
        { name: 'Ok', implementation: 'ReleaseGroupSpecification', fields: { value: '^(FLUX)$' } },
      ],
    });
    const { formats, warnings } = parseCustomFormatJson(json);
    expect(formats[0]?.specifications.map((s) => s.name)).toEqual(['Ok']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/unsupported implementation/);
  });

  it('imports an array of formats and drops nameless entries', () => {
    const { formats, warnings } = parseCustomFormatJson(JSON.stringify([trash, { specifications: [] }]));
    expect(formats.map((f) => f.name)).toEqual(['x265 (HD)']);
    expect(warnings).toEqual(['Skipped an entry without a name']);
  });

  it('round-trips our own export', () => {
    const imported = parseCustomFormatJson(JSON.stringify(trash)).formats[0]!;
    const again = parseCustomFormatJson(JSON.stringify(exportCustomFormat(imported))).formats[0];
    expect(again).toEqual(imported);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseCustomFormatJson('{nope')).toThrow();
  });
});
