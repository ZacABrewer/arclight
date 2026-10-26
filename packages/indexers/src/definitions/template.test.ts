import { describe, expect, it } from 'vitest';
import { pathEncode } from './encoding.js';
import { isTruthy, renderTemplate, TemplateError, templateVariables, validateTemplate, type TemplateVars } from './template.js';

const vars: TemplateVars = {
  'Config.sitelink': 'https://site.example/',
  'Config.freeleech': 'True',
  'Config.empty': null,
  'Config.mode': 'hd',
  'Config.region': '',
  Keywords: 'my show s01e02',
  Categories: ['5', '7'],
  'Query.Categories': ['2000'],
  'Today.Year': '2026',
};

describe('renderTemplate', () => {
  it('passes strings without actions through untouched', () => {
    expect(renderTemplate('plain {text}', vars)).toBe('plain {text}');
  });

  it('substitutes variables and renders missing ones as empty', () => {
    expect(renderTemplate('{{ .Config.sitelink }}browse?q={{ .Keywords }}&x={{ .Nope }}', vars)).toBe(
      'https://site.example/browse?q=my show s01e02&x=',
    );
    expect(renderTemplate('{{ .Today.Year }}', vars)).toBe('2026');
  });

  it('reads setting names that contain hyphens', () => {
    const v: TemplateVars = { 'Config.cat-id': '7', 'Config.filter-id': '' };
    expect(renderTemplate('search-{{ .Config.cat-id }}-x', v)).toBe('search-7-x');
    expect(renderTemplate('{{ if and .Keywords .Config.filter-id }}on{{ else }}off{{ end }}', { ...v, Keywords: 'a' })).toBe('off');
    expect(templateVariables('{{ .Config.cat-id }}')).toContain('Config.cat-id');
  });

  it('handles if / else / end with truthiness rules', () => {
    expect(renderTemplate('{{ if .Config.freeleech }}1{{ else }}0{{ end }}', vars)).toBe('1');
    expect(renderTemplate('{{ if .Config.empty }}1{{ else }}0{{ end }}', vars)).toBe('0');
    expect(renderTemplate('{{ if .Config.region }}1{{ else }}0{{ end }}', vars)).toBe('0');
    expect(renderTemplate('{{ if .Config.freeleech }}only-if{{ end }}', vars)).toBe('only-if');
  });

  it('supports nested if and else if chains', () => {
    const tpl = '{{ if eq .Config.mode "sd" }}S{{ else if eq .Config.mode "hd" }}{{ if .Config.freeleech }}HF{{ else }}H{{ end }}{{ else }}X{{ end }}';
    expect(renderTemplate(tpl, vars)).toBe('HF');
    expect(renderTemplate(tpl, { ...vars, 'Config.mode': 'uhd' })).toBe('X');
  });

  it('implements and/or value semantics (S4.3)', () => {
    expect(renderTemplate('{{ or .Config.region .Config.sitelink }}', vars)).toBe('https://site.example/');
    expect(renderTemplate('{{ and .Config.freeleech .Config.mode }}', vars)).toBe('hd');
    expect(renderTemplate('{{ and .Config.freeleech .Config.empty }}', vars)).toBe('');
    expect(renderTemplate('{{ if and (eq .Config.mode "hd") .Config.freeleech }}x{{ else }}y{{ end }}', vars)).toBe('x');
    expect(renderTemplate('{{ if or (eq .Config.mode "sd") (ne .Config.mode "hd") }}x{{ else }}y{{ end }}', vars)).toBe('y');
  });

  it('compares null and empty distinctly in eq/ne (S4.4)', () => {
    expect(renderTemplate('{{ if eq .Config.empty .Config.missing }}same{{ end }}', vars)).toBe('same');
    expect(renderTemplate('{{ if eq .Config.empty .Config.region }}same{{ else }}diff{{ end }}', vars)).toBe('diff');
  });

  it('iterates lists with range, including index variables', () => {
    expect(renderTemplate('{{ range .Categories }}c{{.}}=1&{{end}}', vars)).toBe('c5=1&c7=1&');
    expect(renderTemplate('{{ range $i, $e := .Categories }}[{{$i}}]{{$e}}{{end}}', vars)).toBe('[0]5[1]7');
    expect(renderTemplate('{{ range .Missing }}x{{ else }}none{{ end }}', vars)).toBe('none');
  });

  it('joins lists and applies re_replace', () => {
    expect(renderTemplate('{{ join .Categories "," }}', vars)).toBe('5,7');
    expect(renderTemplate('{{ re_replace .Keywords "\\s+" "." }}', vars)).toBe('my.show.s01e02');
    expect(renderTemplate('{{ re_replace .Keywords "(s\\d+)(e\\d+)" "${1} ${2}" }}', vars)).toBe('my show s01 e02');
  });

  it('encodes only substituted values when an encoder is given (S4.7)', () => {
    const out = renderTemplate('browse.php?{{ range .Categories }}c{{.}}=1&{{end}}q={{ .Keywords }}', vars, {
      encodeValue: (v) => pathEncode(v, 'utf-8'),
    });
    expect(out).toBe('browse.php?c5=1&c7=1&q=my%20show%20s01e02');
  });

  it('honours whitespace trim markers', () => {
    expect(renderTemplate('a  {{- .Config.mode -}}  b', vars)).toBe('ahdb');
  });

  it('reports syntax errors as TemplateError', () => {
    expect(() => validateTemplate('{{ if .X }}never closed')).toThrow(TemplateError);
    expect(() => validateTemplate('{{ end }}')).toThrow(TemplateError);
    expect(() => validateTemplate('{{ bogus .X }}')).toThrow(/Unknown function/);
    expect(() => validateTemplate('{{ .X ')).toThrow(/Unclosed/);
  });

  it('lists referenced variables', () => {
    expect(templateVariables('{{ if .Config.a }}{{ join .Categories "," }}{{ end }}{{ .Keywords }}').sort()).toEqual([
      'Categories',
      'Config.a',
      'Keywords',
    ]);
  });
});

describe('isTruthy', () => {
  it('follows S4.1', () => {
    expect(isTruthy(null)).toBe(false);
    expect(isTruthy('  ')).toBe(false);
    expect(isTruthy([])).toBe(false);
    expect(isTruthy('0')).toBe(true);
    expect(isTruthy('false')).toBe(true);
    expect(isTruthy(['a'])).toBe(true);
  });
});
