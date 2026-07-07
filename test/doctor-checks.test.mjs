import test from 'node:test';
import assert from 'node:assert/strict';
import { statuslineConfigDiagnostic } from '../scripts/doctor-checks.js';

test('statuslineConfigDiagnostic treats web statusline as self-contained', () => {
  const result = statuslineConfigDiagnostic();

  assert.equal(result.status, 'ok');
  assert.match(result.detail, /SDK/);
  assert.doesNotMatch(result.detail, /settings\.json/);
  assert.doesNotMatch(result.detail, /E16.*禁用/);
});
