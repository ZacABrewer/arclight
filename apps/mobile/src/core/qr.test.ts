import { describe, expect, it } from 'vitest';
import { buildPairingCode, parsePairingCode } from './qr.js';

describe('parsePairingCode', () => {
  it('reads arclight-admin://pair?url=...', () => {
    expect(parsePairingCode('arclight-admin://pair?url=http%3A%2F%2F192.168.1.20%3A7878')).toBe('http://192.168.1.20:7878');
    expect(parsePairingCode('ARCLIGHT-ADMIN://PAIR?url=https%3A%2F%2Farclight.example.com%2Fbase%2F')).toBe('https://arclight.example.com/base');
    expect(parsePairingCode('arclight-admin:pair?url=https%3A%2F%2Fa.example.com')).toBe('https://a.example.com');
  });

  it('still reads the older arclight://pair?url=... codes', () => {
    expect(parsePairingCode('arclight://pair?url=http%3A%2F%2F192.168.1.20%3A7878')).toBe('http://192.168.1.20:7878');
    expect(parsePairingCode('arclight:pair?url=https%3A%2F%2Fa.example.com')).toBe('https://a.example.com');
  });

  it('builds the arclight-admin scheme', () => {
    expect(buildPairingCode('http://nas:7878')).toBe('arclight-admin://pair?url=http%3A%2F%2Fnas%3A7878');
  });

  it('round-trips with buildPairingCode', () => {
    expect(parsePairingCode(buildPairingCode('https://arclight.example.com:8443/x'))).toBe('https://arclight.example.com:8443/x');
  });

  it('accepts a plain server URL', () => {
    expect(parsePairingCode('http://nas:7878/')).toBe('http://nas:7878');
  });

  it('rejects anything else', () => {
    const bad = [
      null,
      '',
      'hello',
      'arclight://other?url=http%3A%2F%2Fx',
      'arclight-admin://other?url=http%3A%2F%2Fx',
      'arclight-player://pair?url=http%3A%2F%2Fx',
      'arclight://pair',
      'arclight-admin://pair?url=javascript%3Aalert(1)',
      'arclight://pair?url=ftp%3A%2F%2Fx',
      'https://user:pw@x.example.com',
      'arclight://pair?url=not%20a%20url',
    ];
    for (const b of bad) expect(parsePairingCode(b), String(b)).toBeNull();
  });
});
