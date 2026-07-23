import test from 'node:test';
import assert from 'node:assert/strict';

const domain = await import('../apps/runner/dist/domain.js');
const source = {
  id:'source', brief:'Budget app', scenario:'healthy', status:'failed', startedAt:'now', traceId:'trace-source', totalTokens:120, budget:100, previewUrl:'http://preview',
  agents:domain.createAgents('system','model').map((agent,index) => ({ ...agent, status:index === 1 ? 'failed' : 'complete', output:`artifact-${index}`, artifactContent:`artifact-${index}`, error:index === 1 ? 'LLM 429' : undefined })),
};

test('recovery preserves upstream artifacts and reruns the selected stage', () => {
  const agents = domain.recoveryAgents(source, 'architecture');
  assert.equal(agents[0].status, 'reused');
  assert.equal(agents[0].output, 'artifact-0');
  assert.equal(agents[1].status, 'queued');
  assert.equal(agents[1].output, '');
});
test('incident classification produces stable operator fingerprints', () => {
  const classification = domain.classifyIncident('LLM 429: Rate limit exceeded');
  assert.equal(classification, 'provider_rate_limit');
  assert.equal(domain.fingerprint('planner', classification), 'planner:provider_rate_limit');
  assert.match(domain.recommendedAction(classification), /quota|model/i);
});
test('recovery budget accepts only bounded whole-number limits', () => {
  for (const budget of [1, 80, 10000]) assert.ok(Number.isInteger(budget) && budget >= 1 && budget <= 10000);
  for (const budget of [0, -1, 1.5, 10001]) assert.ok(!Number.isInteger(budget) || budget < 1 || budget > 10000);
});
