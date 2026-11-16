import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decorateFrameRef,
  normalizeCandidate,
  rankCandidates,
  scoreCandidate,
  decideLocateStatus,
  PERCEPTION_MATRIX,
  LOCATE_STATUSES
} from '../src/perception-contract.js';

const rect = (left = 10, top = 20, width = 120, height = 32) => ({ left, top, width, height });

test('an exact semantic control is strong evidence, and it says why', () => {
  const candidate = normalizeCandidate({
    ref: 'snap:1', tag: 'button', role: 'button', text: '提交',
    clickability: 'semantic-control', covered: false, ...rect()
  }, { strategy: 'semantic-dom', query: '提交', action: 'click' });
  const scored = scoreCandidate(candidate);
  assert.equal(scored.score, 72);
  assert.equal(scored.confidenceLevel, 'high');
  assert.deepEqual(scored.basis, ['exact_text', 'semantic_control']);
  assert.equal(candidate.actionability.compatible, true);
});

test('a text holder is usable but ranked below the semantic control', () => {
  const text = normalizeCandidate({
    ref: 't:1', tag: 'span', label: '提交', matched: '提交', covered: false, rect: rect()
  }, { strategy: 'text-match', query: '提交', action: 'click' });
  const semantic = normalizeCandidate({
    ref: 's:1', tag: 'button', role: 'button', text: '提交', clickability: 'semantic-control', covered: false, rect: rect()
  }, { strategy: 'semantic-dom', query: '提交', action: 'click' });
  const ranked = rankCandidates([text, semantic]);
  assert.equal(ranked[0].ref, 's:1');
  assert.ok(ranked[1].basis.includes('text_holder_only'));
});

test('the same node found by two routes becomes one candidate with both sources', () => {
  const semantic = normalizeCandidate({
    ref: 'a:1', tag: 'button', role: 'button', text: 'Save', clickability: 'semantic-control', covered: false, ...rect()
  }, { strategy: 'semantic-dom', query: 'Save', action: 'click' });
  const text = normalizeCandidate({
    ref: 'b:7', tag: 'button', label: 'Save', matched: 'Save', covered: false, rect: rect()
  }, { strategy: 'text-match', query: 'Save', action: 'click' });
  const ranked = rankCandidates([semantic, text]);
  assert.equal(ranked.length, 1);
  assert.deepEqual(ranked[0].strategies.sort(), ['semantic-dom', 'text-match']);
  assert.equal(ranked[0].ref, 'a:1');
});

test('two different nodes at the same size stay two candidates', () => {
  const left = normalizeCandidate({ ref: 'a:1', tag: 'button', role: 'button', text: 'Save', clickability: 'semantic-control', covered: false, ...rect(10, 20) }, { strategy: 'semantic-dom', query: 'Save', action: 'click' });
  const right = normalizeCandidate({ ref: 'a:2', tag: 'button', role: 'button', text: 'Save', clickability: 'semantic-control', covered: false, ...rect(400, 20) }, { strategy: 'semantic-dom', query: 'Save', action: 'click' });
  const ranked = rankCandidates([left, right]);
  assert.equal(ranked.length, 2);
  assert.equal(decideLocateStatus({ candidates: ranked, coverage: { complete: true } }).status, 'ambiguous');
});

test('cross-frame refs are decorated exactly once', () => {
  assert.equal(decorateFrameRef('snap:4', 0), 'snap:4');
  assert.equal(decorateFrameRef('snap:4', 3), 'snap:4@frame3');
  assert.equal(decorateFrameRef('snap:4@frame3', 3), 'snap:4@frame3');
  const candidate = normalizeCandidate({ ref: 'snap:4', tag: 'button', text: 'Go', covered: false, ...rect() }, { strategy: 'text-match', frameId: 3, query: 'Go', action: 'click' });
  assert.equal(candidate.ref, 'snap:4@frame3');
  assert.equal(scoreCandidate(candidate).basis.includes('cross_frame'), true);
});

test('covered and disabled candidates are never selected, even when nothing else matches', () => {
  const covered = normalizeCandidate({ ref: 'a:1', tag: 'button', text: 'Go', clickability: 'semantic-control', covered: true, ...rect() }, { strategy: 'semantic-dom', query: 'Go', action: 'click' });
  const disabled = normalizeCandidate({ ref: 'a:2', tag: 'button', text: 'Go', clickability: 'semantic-control', disabled: true, ...rect(200, 20) }, { strategy: 'semantic-dom', query: 'Go', action: 'click' });
  const ranked = rankCandidates([covered, disabled]);
  const decision = decideLocateStatus({ candidates: ranked, coverage: { complete: true } });
  assert.equal(decision.status, 'ambiguous');
  assert.equal(decision.reason, 'match_not_actionable');
  assert.equal(decision.selection, null);
});

test('a dominant exact match beats a weaker text holder', () => {
  const strong = normalizeCandidate({ ref: 'a:1', tag: 'button', text: 'Delete', clickability: 'semantic-control', covered: false, ...rect() }, { strategy: 'semantic-dom', query: 'Delete', action: 'click' });
  const weak = normalizeCandidate({ ref: 't:1', tag: 'span', label: 'Delete all', matched: 'Delete', covered: false, rect: rect(300, 20) }, { strategy: 'text-match', query: 'Delete', action: 'click' });
  const decision = decideLocateStatus({ candidates: rankCandidates([strong, weak]), coverage: { complete: true } });
  assert.equal(decision.status, 'found');
  assert.equal(decision.selection.ref, 'a:1');
});

test('not_found requires complete coverage; an incomplete search is inconclusive', () => {
  assert.equal(decideLocateStatus({ candidates: [], coverage: { complete: true } }).status, 'not_found');
  assert.equal(decideLocateStatus({ candidates: [], coverage: { complete: false } }).status, 'inconclusive');
  assert.equal(decideLocateStatus({ candidates: [], coverage: { complete: false, blockedReason: 'frames_not_scriptable' } }).status, 'blocked');
  assert.equal(decideLocateStatus({ candidates: [], coverage: { complete: true, unavailableReason: 'no_read_strategy_succeeded' } }).status, 'unavailable');
});

test('the status vocabulary is closed and honest', () => {
  assert.deepEqual(LOCATE_STATUSES, ['found', 'ambiguous', 'partial', 'inconclusive', 'not_found', 'unavailable', 'blocked']);
  assert.equal(PERCEPTION_MATRIX.ocr.status, 'not_implemented');
  assert.equal(PERCEPTION_MATRIX.canvas.status, 'partial');
  assert.equal(PERCEPTION_MATRIX.accessibility.status, 'available_opt_in');
  assert.match(PERCEPTION_MATRIX.ocr.note, /screenshot plus coordinates/);
});
