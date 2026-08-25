import { describe, expect, it } from 'vitest';
import { base32Decode, generateTotp } from '../src/spotify/totp.js';

// RFC 6238 Appendix B uses the ASCII secret "12345678901234567890".
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32Decode', () => {
  it('round-trips the RFC 6238 secret', () => {
    expect(base32Decode(RFC_SECRET).toString('ascii')).toBe('12345678901234567890');
  });

  it('accepts padding, whitespace and lower case', () => {
    // RFC 4648 vectors: "foo" is MZXW6===, "foobar" is MZXW6YTBOI======.
    expect(base32Decode('MZXW6===').toString('ascii')).toBe('foo');
    expect(base32Decode('mzxw6').toString('ascii')).toBe('foo');
    expect(base32Decode('MZXW 6').toString('ascii')).toBe('foo');
    expect(base32Decode('MZXW6YTBOI======').toString('ascii')).toBe('foobar');
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base32Decode('MZXW6!!')).toThrow(/invalid base32/i);
  });
});

describe('generateTotp', () => {
  // Vectors from RFC 6238 Appendix B (SHA-1 column).
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ];

  for (const [seconds, expected] of vectors) {
    it(`matches the RFC vector at T=${seconds}`, () => {
      expect(generateTotp(RFC_SECRET, { digits: 8, timestampMs: seconds * 1000 })).toBe(expected);
    });
  }

  it('defaults to six digits', () => {
    const code = generateTotp(RFC_SECRET, { timestampMs: 59_000 });
    expect(code).toBe('287082');
    expect(code).toHaveLength(6);
  });

  it('is stable inside a period and changes across one', () => {
    const early = generateTotp(RFC_SECRET, { timestampMs: 30_000 });
    const late = generateTotp(RFC_SECRET, { timestampMs: 59_999 });
    const next = generateTotp(RFC_SECRET, { timestampMs: 60_000 });
    expect(early).toBe(late);
    expect(next).not.toBe(late);
  });
});
