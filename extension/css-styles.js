// Read the CSS cascade the way the DevTools Styles pane does, without editing
// anything. This is the answer to "why is this element this colour": the
// matched rules with their origin and selector, the declarations each rule
// contributes, the inherited chain, and the computed value the page actually
// uses. It runs against the existing tab through the debugger channel, so it
// works in a background tab and needs no second browser.
//
// The CSS domain is not guaranteed to be forwarded by chrome.debugger on every
// Chrome build. When it is missing the reply says unsupported instead of
// pretending the element has no rules; a selector that matches nothing is a
// different answer and is reported separately.

const MAX_SELECTOR_CHARS = 400;
const MAX_PROPERTY_VALUE_CHARS = 600;
const MAX_RULES = 80;
const MAX_INHERITED_LEVELS = 6;
const MAX_COMPUTED_PROPERTIES = 500;
const MAX_KEYFRAMES = 20;

function clampText(value, limit) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function isUnsupported(error) {
  const message = String(error?.message ?? error ?? '');
  return /-32601|wasn't found|is not supported|not supported by this channel|not found/i.test(message);
}

function cssProperty(property) {
  return {
    name: clampText(property?.name, 120),
    value: clampText(property?.value, MAX_PROPERTY_VALUE_CHARS),
    important: property?.important === true,
    implicit: property?.implicit === true,
    disabled: property?.disabled === true,
    parsedOk: property?.parsedOk !== false,
    text: property?.text ? clampText(property.text, MAX_PROPERTY_VALUE_CHARS) : null
  };
}

function styleBlock(style) {
  if (!style) return null;
  return {
    cssProperties: Array.isArray(style.cssProperties) ? style.cssProperties.map(cssProperty) : [],
    shorthandEntries: Array.isArray(style.shorthandEntries)
      ? style.shorthandEntries.map(entry => ({ name: clampText(entry?.name, 120), value: clampText(entry?.value, MAX_PROPERTY_VALUE_CHARS) }))
      : []
  };
}

function selectorText(selectorList) {
  return selectorList?.text ? clampText(selectorList.text, MAX_SELECTOR_CHARS) : null;
}

function mediaText(media) {
  return Array.isArray(media)
    ? media.map(item => clampText(item?.text ?? item, 300)).filter(Boolean)
    : [];
}

function mapRule(rule, matchingSelectors = []) {
  if (!rule) return null;
  return {
    origin: clampText(rule.origin ?? 'regular', 40),
    selectorText: selectorText(rule.selectorList),
    matchingSelectors: Array.isArray(matchingSelectors) ? matchingSelectors.slice(0, 20) : [],
    style: styleBlock(rule.style),
    media: mediaText(rule.media),
    containerQueries: Array.isArray(rule.containerQueries)
      ? rule.containerQueries.map(item => clampText(item?.text ?? item, 300)).filter(Boolean)
      : [],
    supports: Array.isArray(rule.supports) ? rule.supports.map(item => clampText(item?.text ?? item, 300)).filter(Boolean) : [],
    layers: Array.isArray(rule.layers) ? rule.layers.map(item => clampText(item?.text ?? item, 300)).filter(Boolean) : [],
    scope: rule.scope ? clampText(rule.scope.text ?? rule.scope, 300) : null
  };
}

function mapMatched(matchedCSSRules) {
  return (Array.isArray(matchedCSSRules) ? matchedCSSRules : [])
    .slice(0, MAX_RULES)
    .map(item => mapRule(item?.rule, item?.matchingSelectors))
    .filter(Boolean);
}

function mapNode(node) {
  if (!node) return null;
  const attributes = [];
  for (let index = 0; index + 1 < (node.attributes?.length ?? 0); index += 2) {
    attributes.push([clampText(node.attributes[index], 120), clampText(node.attributes[index + 1], 400)]);
  }
  return {
    nodeId: node.nodeId ?? null,
    backendNodeId: node.backendNodeId ?? null,
    nodeType: node.nodeType ?? null,
    nodeName: clampText(node.nodeName, 120),
    localName: clampText(node.localName, 120),
    nodeValue: clampText(node.nodeValue, 200),
    attributes
  };
}

export async function readCssStyles({ send, selector = '', nodeId = null, includeInherited = true, maxRules = MAX_RULES } = {}) {
  if (typeof send !== 'function') throw new Error('readCssStyles requires a CDP send function');
  const wantedSelector = typeof selector === 'string' ? selector.trim() : '';
  const wantedNodeId = Number.isSafeInteger(nodeId) && nodeId > 0 ? nodeId : null;
  if (!wantedSelector && !wantedNodeId) {
    return {
      status: 'denied', retryable: false, reason: 'selector_or_node_id_required', dispatched: false,
      message: 'Pass a CSS selector or a nodeId from a prior read. Nothing was queried.'
    };
  }

  try {
    await send('DOM.enable');
    await send('CSS.enable');
  } catch (error) {
    if (isUnsupported(error)) {
      return {
        status: 'unsupported', retryable: false, reason: 'css_domain_unavailable', dispatched: false,
        message: 'This Chrome build does not expose the CSS domain over chrome.debugger, so the cascade cannot be read from CDP. Nothing was changed. The computed style is still readable through browser_eval.'
      };
    }
    return {
      status: 'failed', retryable: true, reason: 'css_domain_enable_failed', dispatched: false,
      message: String(error?.message ?? error)
    };
  }

  let root;
  try {
    root = await send('DOM.getDocument', { depth: 0, pierce: false });
  } catch (error) {
    return { status: 'failed', retryable: true, reason: 'dom_document_unavailable', dispatched: false,
      message: String(error?.message ?? error) };
  }
  const documentNodeId = root?.root?.nodeId;
  if (!Number.isSafeInteger(documentNodeId)) {
    return { status: 'failed', retryable: true, reason: 'dom_document_missing', dispatched: false,
      message: 'Chrome returned no document node for this tab.' };
  }

  let resolvedNodeId = wantedNodeId;
  if (!resolvedNodeId) {
    let query;
    try {
      query = await send('DOM.querySelector', { nodeId: documentNodeId, selector: wantedSelector });
    } catch (error) {
      if (/invalid selector|syntax/i.test(String(error?.message ?? error))) {
        return { status: 'denied', retryable: false, reason: 'invalid_selector', dispatched: false,
          message: `The selector could not be parsed: ${String(error?.message ?? error)}. Nothing was read.` };
      }
      return { status: 'failed', retryable: true, reason: 'selector_query_failed', dispatched: false,
        message: String(error?.message ?? error) };
    }
    resolvedNodeId = query?.nodeId;
    if (!resolvedNodeId) {
      return { status: 'not_found', retryable: false, reason: 'selector_matched_no_node', dispatched: false,
        selector: clampText(wantedSelector, 1000),
        message: 'The selector matched no element in the main frame. It is not evidence that the element does not exist in an iframe or shadow root.' };
    }
  }

  let described;
  let matched;
  let computed;
  try {
    [described, matched, computed] = await Promise.all([
      send('DOM.describeNode', { nodeId: resolvedNodeId, depth: 0 }).catch(() => null),
      send('CSS.getMatchedStylesForNode', { nodeId: resolvedNodeId }),
      send('CSS.getComputedStyleForNode', { nodeId: resolvedNodeId })
    ]);
  } catch (error) {
    if (isUnsupported(error)) {
      return { status: 'unsupported', retryable: false, reason: 'css_cascade_unavailable', dispatched: false,
        nodeId: resolvedNodeId, message: 'The CSS domain answered enable but not the cascade command. Nothing was changed.' };
    }
    return { status: 'failed', retryable: true, reason: 'css_cascade_failed', dispatched: false,
      nodeId: resolvedNodeId, message: String(error?.message ?? error) };
  }

  const computedStyle = Array.isArray(computed?.computedStyle)
    ? computed.computedStyle.slice(0, MAX_COMPUTED_PROPERTIES).map(property => ({
        name: clampText(property?.name, 120), value: clampText(property?.value, MAX_PROPERTY_VALUE_CHARS)
      }))
    : [];
  const customProperties = computedStyle.filter(property => property.name.startsWith('--'));
  const limit = Math.min(MAX_RULES, Math.max(1, Number.isSafeInteger(maxRules) ? maxRules : MAX_RULES));
  const rules = mapMatched(matched?.matchedCSSRules).slice(0, limit);
  const inherited = includeInherited !== false
    ? (Array.isArray(matched?.inherited) ? matched.inherited : []).slice(0, MAX_INHERITED_LEVELS).map(chain => ({
        matchedCSSRules: mapMatched(chain?.matchedCSSRules).slice(0, limit),
        inlineStyle: styleBlock(chain?.inlineStyle)
      }))
    : [];
  const pseudoElements = (Array.isArray(matched?.pseudoElements) ? matched.pseudoElements : [])
    .slice(0, 20)
    .map(item => ({
      pseudoType: clampText(item?.pseudoType, 40),
      pseudoIdentifier: item?.pseudoIdentifier ? clampText(item.pseudoIdentifier, 80) : null,
      matches: mapMatched(item?.matches).slice(0, limit)
    }));

  const matchedCount = Array.isArray(matched?.matchedCSSRules) ? matched.matchedCSSRules.length : 0;
  return {
    status: 'success', retryable: false, dispatched: false,
    selector: wantedSelector || null,
    nodeId: resolvedNodeId,
    node: mapNode(described?.node),
    matchedCount,
    matchedRules: rules,
    rulesTruncated: matchedCount > rules.length,
    inlineStyle: styleBlock(matched?.inlineStyle),
    attributesStyle: styleBlock(matched?.attributesStyle),
    inherited,
    inheritedTruncated: Array.isArray(matched?.inherited) && matched.inherited.length > inherited.length,
    pseudoElements,
    computedStyle,
    computedTruncated: Array.isArray(computed?.computedStyle) && computed.computedStyle.length > computedStyle.length,
    customProperties,
    keyframesRules: (Array.isArray(matched?.cssKeyframesRules) ? matched.cssKeyframesRules : [])
      .slice(0, MAX_KEYFRAMES)
      .map(rule => ({ animationName: clampText(rule?.animationName, 120), keyframes: Array.isArray(rule?.keyframes) ? rule.keyframes.length : null })),
    contentTrust: 'untrusted page CSS and DOM',
    limits: { maxRules: limit, maxInheritedLevels: MAX_INHERITED_LEVELS, maxComputedProperties: MAX_COMPUTED_PROPERTIES },
    note: 'Read-only: no rule was edited and the page was not reloaded. The cascade is what this tab\'s main frame currently uses; cross-origin iframes and closed shadow roots are separate targets. CSS custom properties are listed separately because they are often the real answer.'
  };
}
