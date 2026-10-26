import { describe, expect, it } from 'vitest';
import responses from '../../fixtures/rtorrent/responses.json' with { type: 'json' };
import {
  decodeEntities,
  decodeMethodCall,
  decodeMethodResponse,
  encodeFault,
  encodeMethodCall,
  encodeMethodResponse,
  escapeXml,
  XmlRpcDouble,
  XmlRpcFault,
  XmlRpcI8,
  XmlRpcParseError,
} from './xmlrpc.js';

function response(inner: string): string {
  return `<?xml version="1.0"?><methodResponse><params><param>${inner}</param></params></methodResponse>`;
}

describe('XML-RPC encoding', () => {
  it('encodes scalars with the right type tags', () => {
    const xml = encodeMethodCall('test.method', ['a<b>&"\'', 42, -7, 2 ** 40, 1.5, true, false, null]);
    expect(xml).toContain('<methodName>test.method</methodName>');
    expect(xml).toContain('<value><string>a&lt;b&gt;&amp;&quot;&apos;</string></value>');
    expect(xml).toContain('<value><i4>42</i4></value>');
    expect(xml).toContain('<value><i4>-7</i4></value>');
    expect(xml).toContain('<value><i8>1099511627776</i8></value>');
    expect(xml).toContain('<value><double>1.5</double></value>');
    expect(xml).toContain('<value><boolean>1</boolean></value>');
    expect(xml).toContain('<value><boolean>0</boolean></value>');
    expect(xml).toContain('<value><nil/></value>');
  });

  it('honours explicit double and i8 wrappers', () => {
    const xml = encodeMethodCall('m', [new XmlRpcDouble(2), new XmlRpcI8(5)]);
    expect(xml).toContain('<double>2</double>');
    expect(xml).toContain('<i8>5</i8>');
  });

  it('encodes base64, arrays and structs', () => {
    const xml = encodeMethodCall('m', [new Uint8Array([0, 1, 254, 255]), ['x', 1], { 'k&': 'v', n: [true] }]);
    expect(xml).toContain('<base64>AAH+/w==</base64>');
    expect(xml).toContain('<array><data><value><string>x</string></value><value><i4>1</i4></value></data></array>');
    expect(xml).toContain('<struct><member><name>k&amp;</name><value><string>v</string></value></member>');
  });

  it('rejects non-finite numbers', () => {
    expect(() => encodeMethodCall('m', [Number.NaN])).toThrow(XmlRpcParseError);
    expect(() => encodeMethodCall('m', [Number.POSITIVE_INFINITY])).toThrow(XmlRpcParseError);
  });

  it('round-trips a method call through the decoder', () => {
    const params = ['', new Uint8Array([100, 56, 58]), 'd.custom1.set="tv"', 3, { a: [1, 'b', false] }];
    const decoded = decodeMethodCall(encodeMethodCall('load.raw_start', params));
    expect(decoded.method).toBe('load.raw_start');
    expect(decoded.params).toEqual(params);
  });
});

describe('XML-RPC decoding', () => {
  it('decodes every scalar type, untyped strings and ex:i8', () => {
    const xml = response(
      '<value><array><data>' +
        '<value>plain text</value>' +
        '<value><string>typed</string></value>' +
        '<value><i4>-12</i4></value>' +
        '<value><int>7</int></value>' +
        '<value><i8>8589934592</i8></value>' +
        '<value><ex:i8>9</ex:i8></value>' +
        '<value><boolean>1</boolean></value>' +
        '<value><boolean>0</boolean></value>' +
        '<value><double>-0.25</double></value>' +
        '<value><base64>aGVs\nbG8=</base64></value>' +
        '<value><nil/></value>' +
        '<value><dateTime.iso8601>20261025T10:00:00</dateTime.iso8601></value>' +
        '<value></value>' +
        '<value><string/></value>' +
        '</data></array></value>',
    );
    expect(decodeMethodResponse(xml)).toEqual([
      'plain text',
      'typed',
      -12,
      7,
      8589934592,
      9,
      true,
      false,
      -0.25,
      new TextEncoder().encode('hello'),
      null,
      '20261025T10:00:00',
      '',
      '',
    ]);
  });

  it('decodes nested structs and arrays', () => {
    const xml = response(
      '<value><struct><member><name>list</name><value><array><data><value><i4>1</i4></value></data></array></value></member>' +
        '<member><name>inner</name><value><struct><member><name>x</name><value>y</value></member></struct></value></member></struct></value>',
    );
    expect(decodeMethodResponse(xml)).toEqual({ list: [1], inner: { x: 'y' } });
  });

  it('decodes a realistic rTorrent multicall response with entities and whitespace', () => {
    const rows = decodeMethodResponse(responses.multicall) as unknown[][];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.[1]).toBe('Show & Tell S01E01 <1080p>');
    expect(rows[0]?.[3]).toBe(1000000);
    expect(rows[1]?.[1]).toBe('Café ☃ Movie.mkv');
    expect(rows[1]?.[3]).toBe(8589934592);
    expect(rows[1]?.[15]).toBe('Tracker: [Timeout was reached]');
  });

  it('decodes CDATA, comments and a BOM', () => {
    const xml = `﻿<?xml version="1.0"?><!-- hi --><methodResponse><params><param><value><string><![CDATA[a<b]]> &amp; c</string></value></param></params></methodResponse>`;
    expect(decodeMethodResponse(xml)).toBe('a<b & c');
  });

  it('turns a fault into XmlRpcFault with code and string', () => {
    try {
      decodeMethodResponse(responses.faultUnknownHash);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(XmlRpcFault);
      expect((error as XmlRpcFault).faultCode).toBe(-501);
      expect((error as XmlRpcFault).faultString).toBe('Could not find info-hash.');
    }
    expect(() => decodeMethodResponse(encodeFault(-1, 'nope & <bad>'))).toThrow(/nope & <bad>/);
  });

  it('returns null for an empty params list and round-trips encodeMethodResponse', () => {
    expect(decodeMethodResponse('<methodResponse><params></params></methodResponse>')).toBeNull();
    expect(decodeMethodResponse(encodeMethodResponse(['x', 2, { y: true }]))).toEqual(['x', 2, { y: true }]);
  });

  it('handles the predefined and numeric entities', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&apos;&#65;&#x42;&#x1F600;')).toBe('&<>"\'AB\u{1F600}');
    expect(escapeXml('<&>')).toBe('&lt;&amp;&gt;');
    expect(() => decodeEntities('&nbsp;')).toThrow(XmlRpcParseError);
    expect(() => decodeEntities('a & b')).toThrow(XmlRpcParseError);
  });

  it('rejects malformed or non-XML-RPC documents', () => {
    const bad = [
      '',
      'not xml',
      responses.htmlLoginPage,
      '<methodResponse><params><param><value><i4>x</i4></value></param></params></methodResponse>',
      '<methodResponse><params><param><value><boolean>2</boolean></value></param></params></methodResponse>',
      '<methodResponse><params><param><value><string>a</value></param></params></methodResponse>',
      '<methodResponse><params><param><value><unknown/></value></param></params></methodResponse>',
      '<methodResponse><params>',
    ];
    for (const xml of bad) expect(() => decodeMethodResponse(xml), xml).toThrow(XmlRpcParseError);
  });
});
