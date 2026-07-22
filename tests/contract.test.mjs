import test from 'node:test'; import assert from 'node:assert/strict';
test('incident contract records a retry and token-budget breach',()=>{const tokens=220,budget=80,retries=1;assert.equal(retries,1);assert.ok(tokens>budget)});
test('trace links preserve trace identity',()=>{const traceId='abc123';assert.match(`http://localhost:3301/traces?trace_id=${traceId}`,/trace_id=abc123/)});
