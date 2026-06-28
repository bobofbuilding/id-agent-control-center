import assert from 'node:assert/strict';
import { sanitizeDesignedTeam } from './client.ts';

const OPTS = {
  runtimes: ['claude-code-cli', 'codex-cli'],
  models: { 'claude-code-cli': ['claude-opus-4-8'], 'codex-cli': ['gpt-5.5'] },
  skills: ['inter-agent', 'deep-research'],
};

function testHappyPath() {
  const r = sanitizeDesignedTeam({
    team: 'My App',
    agents: [
      { name: 'Lead', role: 'coordinator', description: 'runs the team', runtime: 'claude-code-cli', model: 'claude-opus-4-8', skills: ['inter-agent'], lead: true },
      { name: 'coder', role: 'impl', description: 'writes code', runtime: 'codex-cli', model: 'gpt-5.5', skills: ['deep-research'] },
    ],
  }, OPTS);
  assert.equal(r.team, 'my-app', 'team is slugged');
  assert.equal(r.agents.length, 2);
  assert.equal(r.agents[0].name, 'lead', 'agent name is slugged');
  assert.equal(r.agents[0].lead, true);
  assert.equal(r.agents[0].runtime, 'claude-code-cli');
  assert.equal(r.agents[0].model, 'claude-opus-4-8');
  assert.deepEqual(r.agents[0].skills, ['inter-agent']);
}

function testDropsOffListPicks() {
  const r = sanitizeDesignedTeam({
    team: null,
    agents: [
      { name: 'a', role: '', description: '', runtime: 'made-up-runtime', model: 'ghost-model', skills: ['inter-agent', 'not-a-skill'] },
    ],
  }, OPTS);
  assert.equal(r.agents[0].runtime, undefined, 'off-list runtime dropped');
  assert.equal(r.agents[0].model, undefined, 'off-list model dropped');
  assert.deepEqual(r.agents[0].skills, ['inter-agent'], 'only library skills kept');
}

function testModelRequiresMatchingRuntime() {
  // A valid model but for the WRONG runtime must be dropped (model is validated
  // against the chosen runtime's catalog).
  const r = sanitizeDesignedTeam({
    agents: [{ name: 'a', role: '', description: '', runtime: 'codex-cli', model: 'claude-opus-4-8' }],
  }, OPTS);
  assert.equal(r.agents[0].runtime, 'codex-cli');
  assert.equal(r.agents[0].model, undefined, 'model not in codex-cli catalog is dropped');
}

function testSingleLeadGuarantee() {
  // No lead flagged → first agent becomes lead.
  const none = sanitizeDesignedTeam({ agents: [{ name: 'a', role: '', description: '' }, { name: 'b', role: '', description: '' }] }, OPTS);
  assert.equal(none.agents[0].lead, true);
  assert.equal(none.agents[1].lead, false);
  // Multiple leads flagged → only the first survives.
  const many = sanitizeDesignedTeam({
    agents: [{ name: 'a', role: '', description: '', lead: true }, { name: 'b', role: '', description: '', lead: true }],
  }, OPTS);
  assert.equal(many.agents.filter((x) => x.lead).length, 1, 'exactly one lead');
  assert.equal(many.agents[0].lead, true);
}

function testDedupeAndFallbacks() {
  const r = sanitizeDesignedTeam({
    agents: [
      { name: 'Dup', role: 'first', description: '' },
      { name: 'dup', role: 'second', description: '' }, // same slug → dropped
      { name: '', role: 'noname', description: '' },     // empty name → dropped
      { name: 'solo', role: 'only role', description: '' }, // description falls back to role
    ],
  }, OPTS);
  assert.equal(r.agents.length, 2, 'duplicate + empty-name agents removed');
  assert.equal(r.agents.map((a) => a.name).join(','), 'dup,solo');
  assert.equal(r.agents[1].description, 'only role', 'description falls back to role');
}

function testSuggestions() {
  const r = sanitizeDesignedTeam({
    agents: [{ name: 'lead', role: 'coord', description: 'coordinates', lead: true }],
    suggestions: {
      agents: ['Skill curator', 'Skill curator', 'Capability auditor'],
      skills: ['Browser research pack', '', 'Reusable onboarding checklist'],
    },
  }, OPTS);
  assert.deepEqual(r.suggestions?.agents, ['Skill curator', 'Capability auditor']);
  assert.deepEqual(r.suggestions?.skills, ['Browser research pack', 'Reusable onboarding checklist']);
}

function testEmptyAndGarbage() {
  assert.deepEqual(sanitizeDesignedTeam({}, OPTS), { team: null, agents: [] });
  assert.deepEqual(sanitizeDesignedTeam({ agents: 'nope' as unknown as unknown[] }, OPTS), { team: null, agents: [] });
  // With no offered runtimes/skills, everything is dropped but agents still parse.
  const r = sanitizeDesignedTeam({ agents: [{ name: 'x', role: 'r', description: 'd', runtime: 'codex-cli', skills: ['inter-agent'] }] });
  assert.equal(r.agents[0].runtime, undefined);
  assert.equal(r.agents[0].skills?.length, 0);
}

testHappyPath();
testDropsOffListPicks();
testModelRequiresMatchingRuntime();
testSingleLeadGuarantee();
testDedupeAndFallbacks();
testSuggestions();
testEmptyAndGarbage();
console.log('team design sanitization tests passed');
