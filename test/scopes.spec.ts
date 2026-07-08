import { describe, it, expect } from 'vitest';
import { SCOPES, TOOL_SCOPES, ALL_TOOL_NAMES, hasRequiredScopes, missingScopes } from '../src/auth/scopes.js';

describe('scopes', () => {
  it('every tool maps only to declared scopes', () => {
    const valid = new Set<string>(SCOPES);
    for (const [tool, scopes] of Object.entries(TOOL_SCOPES)) {
      expect(scopes.length, `${tool} has no scopes`).toBeGreaterThan(0);
      for (const s of scopes) expect(valid.has(s), `${tool} → unknown scope ${s}`).toBe(true);
    }
  });

  it('initiate_wire requires BOTH payments:write and wire:write', () => {
    expect(TOOL_SCOPES.initiate_wire).toEqual(['payments:write', 'wire:write']);
    expect(hasRequiredScopes('initiate_wire', new Set(['payments:write']))).toBe(false);
    expect(missingScopes('initiate_wire', new Set(['payments:write']))).toEqual(['wire:write']);
    expect(hasRequiredScopes('initiate_wire', new Set(['payments:write', 'wire:write']))).toBe(true);
  });

  it('exposes 20 tools spanning read/write/payments/admin', () => {
    expect(ALL_TOOL_NAMES.length).toBe(20);
    expect(hasRequiredScopes('search_customers', new Set(['banking:read']))).toBe(true);
    expect(hasRequiredScopes('adjust_balance', new Set(['banking:read']))).toBe(false);
  });
});
