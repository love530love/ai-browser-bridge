// The CSS cascade reader is only useful if its failures are distinguishable:
// "the domain is not available", "the selector matched nothing" and "there are
// no rules" are three different answers that a callers' next step depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCssStyles } from '../extension/css-styles.js';

function sender(overrides = {}) {
  const sent = [];
  const send = async (method, params = {}) => {
    sent.push({ method, params });
    if (Object.hasOwn(overrides, method)) {
      const value = overrides[method];
      if (value instanceof Error) throw value;
      return typeof value === 'function' ? value(params) : value;
    }
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 42 };
    if (method === 'DOM.describeNode') return { node: { nodeId: 42, nodeName: 'BUTTON', localName: 'button' } };
    if (method === 'CSS.getMatchedStylesForNode' || method === 'CSS.getComputedStyleForNode') return {};
    return {};
  };
  return { send, sent };
}

test('a missing selector and nodeId is refused before any CDP call', async () => {
  const { send, sent } = sender();
  const result = await readCssStyles({ send });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'selector_or_node_id_required');
  assert.deepEqual(sent, []);
});

test('an unavailable CSS domain is unsupported, not an empty cascade', async () => {
  const error = new Error("'CSS.enable' wasn't found");
  const { send } = sender({ 'CSS.enable': error });
  const result = await readCssStyles({ send, selector: '#submit' });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'css_domain_unavailable');
  assert.equal(result.dispatched, false);
  assert.match(result.message, /browser_eval/);
});

test('a selector that matches nothing is not evidence about iframes or shadow roots', async () => {
  const { send } = sender({ 'DOM.querySelector': { nodeId: 0 } });
  const result = await readCssStyles({ send, selector: '#missing' });
  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'selector_matched_no_node');
  assert.match(result.message, /iframe or shadow root/);
});

test('an invalid selector is a denial with the parser message', async () => {
  const { send } = sender({ 'DOM.querySelector': new Error('Invalid selector: unexpected token') });
  const result = await readCssStyles({ send, selector: '???`' });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'invalid_selector');
});

test('matched rules keep origin, selector and declarations, and the limits are visible', async () => {
  const matched = {
    matchedCSSRules: [
      {
        rule: {
          origin: 'regular',
          selectorList: { text: '.btn.primary' },
          style: { cssProperties: [{ name: 'background-color', value: 'rgb(0, 90, 200)', important: true }], shorthandEntries: [] },
          media: [{ text: 'screen' }]
        },
        matchingSelectors: [0]
      },
      {
        rule: {
          origin: 'user-agent',
          selectorList: { text: 'button' },
          style: { cssProperties: [{ name: 'padding', value: '4px 8px' }], shorthandEntries: [] }
        },
        matchingSelectors: [0]
      }
    ],
    inherited: [
      { matchedCSSRules: [{ rule: { origin: 'regular', selectorList: { text: 'body' }, style: { cssProperties: [{ name: 'color', value: 'black' }] } }, matchingSelectors: [0] }], inlineStyle: null }
    ],
    inlineStyle: { cssProperties: [{ name: 'margin', value: '0' }], shorthandEntries: [] },
    pseudoElements: [{ pseudoType: 'before', pseudoIdentifier: null, matches: [] }],
    cssKeyframesRules: [{ animationName: 'spin', keyframes: [{}, {}] }]
  };
  const computed = {
    computedStyle: [
      { name: 'background-color', value: 'rgb(0, 90, 200)' },
      { name: '--brand', value: '#005ac8' }
    ]
  };
  const { send, sent } = sender({
    'CSS.getMatchedStylesForNode': matched,
    'CSS.getComputedStyleForNode': computed
  });
  const result = await readCssStyles({ send, selector: '.btn', maxRules: 1, includeInherited: true });
  assert.equal(result.status, 'success');
  assert.equal(result.nodeId, 42);
  assert.equal(result.matchedCount, 2);
  assert.equal(result.matchedRules.length, 1);
  assert.equal(result.rulesTruncated, true);
  assert.equal(result.matchedRules[0].origin, 'regular');
  assert.equal(result.matchedRules[0].selectorText, '.btn.primary');
  assert.equal(result.matchedRules[0].style.cssProperties[0].important, true);
  assert.equal(result.inherited.length, 1);
  assert.equal(result.inherited[0].matchedCSSRules[0].selectorText, 'body');
  assert.equal(result.inlineStyle.cssProperties[0].name, 'margin');
  assert.equal(result.pseudoElements[0].pseudoType, 'before');
  assert.equal(result.keyframesRules[0].animationName, 'spin');
  assert.deepEqual(result.customProperties, [{ name: '--brand', value: '#005ac8' }]);
  assert.deepEqual(result.limits, { maxRules: 1, maxInheritedLevels: 6, maxComputedProperties: 500 });
  assert.match(result.note, /Read-only/);
  assert.ok(sent.some(item => item.method === 'CSS.enable'));
});
