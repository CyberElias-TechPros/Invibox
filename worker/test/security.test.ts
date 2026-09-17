import { describe,expect,it } from 'vitest';
import { hashPassword, randomToken, sha256, verifyPassword } from '../src/security';

describe('security primitives',()=>{
  it('hashes and verifies passwords without retaining plaintext',async()=>{
    const encoded=await hashPassword('A-strong-password-2026');
    expect(encoded).not.toContain('A-strong-password-2026');
    expect(await verifyPassword('A-strong-password-2026',encoded)).toBe(true);
    expect(await verifyPassword('wrong-password',encoded)).toBe(false);
  });
  it('creates high entropy unique invitation/session tokens',()=>{
    const first=randomToken(),second=randomToken();
    expect(first.length).toBeGreaterThanOrEqual(40);
    expect(first).not.toBe(second);
  });
  it('produces stable SHA-256 token indexes',async()=>{
    expect(await sha256('guest-token')).toBe(await sha256('guest-token'));
    expect(await sha256('guest-token')).not.toBe(await sha256('other-token'));
  });
});
