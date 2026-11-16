// One target description for every way of perceiving a page.
//
// The bridge could already find an element four ways - semantic DOM search,
// visible-text search, shadow-root traversal and the accessibility tree - and
// each answered in its own shape. A caller had to know which shape it was
// holding before it could compare two results, so "found by text" and "found by
// role" could not be weighed against each other. This module is the common
// shape: a TargetCandidate that says where it came from, what it can be used
// for, and why it ranks where it does.
//
// Everything here is deterministic. There is no model, no probability and no
// opaque "confidence" number: `score` is an integer built from named facts, and
// `basis` lists those facts so a caller can disagree with the ranking instead of
// trusting it.

export const LOCATE_ACTIONS = ['click', 'fill', 'select', 'upload', 'any'];
export const LOCATE_STATUSES = ['found', 'ambiguous', 'partial', 'inconclusive', 'not_found', 'unavailable', 'blocked'];
const NEED_REF_STATUSES = new Set(['found']);

// Each strategy is a perception route, not a ranking trick. The weight reflects
// how much a result from that route proves on its own: a semantic control with
// an observed hit test is stronger evidence than a text node that might be
// clickable because its ancestor is.
export const STRATEGIES = [
  {
    id: 'semantic-dom',
    tool: 'browser_find_element',
    weight: 12,
    scope: 'main frame, light DOM',
    proves: 'role/tag, label, geometry, covered state, enabled state',
    doesNotProve: 'that clicking it performs the intended business action'
  },
  {
    id: 'accessibility',
    tool: 'browser_ax_snapshot',
    weight: 10,
    scope: 'accessibility tree, includes shadow DOM, excludes display:none',
    proves: 'the semantic role and name a screen reader sees',
    doesNotProve: 'a clickable ref or geometry, so it can corroborate but never be selected'
  },
  {
    id: 'shadow-dom',
    tool: 'browser_shadow_tree',
    weight: 8,
    scope: 'open shadow roots plus cursor:pointer containers',
    proves: 'a ref inside a shadow root, and which container looks clickable',
    doesNotProve: 'that a cursor:pointer container owns the intended handler'
  },
  {
    id: 'text-match',
    tool: 'browser_find_text',
    weight: 6,
    scope: 'visible text in the main frame or all accessible frames',
    proves: 'that the text is on screen and which deepest element holds it',
    doesNotProve: 'that the holder is the control, or that clicking it is safe'
  }
];

export const STRATEGY_BY_ID = new Map(STRATEGIES.map(strategy => [strategy.id, strategy]));

// The machine-readable answer to "how can this bridge perceive a page at all".
// It is separate from browser_capabilities' protected-UI section because this
// list is about the ordinary page surface, and the gaps in it are the gaps a
// caller must route around rather than retry.
export const PERCEPTION_MATRIX = {
  dom: {
    status: 'available',
    tools: ['browser_read', 'browser_find_element', 'browser_at'],
    scope: 'main frame light DOM and portal overlays',
    backgroundSafe: true
  },
  shadowDom: {
    status: 'available',
    tools: ['browser_shadow_tree'],
    scope: 'open shadow roots; closed roots are not reachable from page script',
    backgroundSafe: true
  },
  frames: {
    status: 'available',
    tools: ['browser_frames', 'browser_find_text', 'browser_read'],
    scope: 'same-origin frames through chrome.scripting; refs are decorated @frameN',
    backgroundSafe: true
  },
  accessibility: {
    status: 'available_opt_in',
    tools: ['browser_ax_snapshot'],
    scope: 'Chrome accessibility tree through a debugger session',
    requires: 'a temporary debugger attachment, which may show Chrome\'s debugging banner',
    backgroundSafe: true
  },
  visual: {
    status: 'available',
    tools: ['browser_screenshot'],
    scope: 'screencast or capture of a backgrounded tab',
    backgroundSafe: true
  },
  coordinate: {
    status: 'available',
    tools: ['browser_prepare_coordinate', 'browser_action'],
    scope: 'element-bound token, re-hit-tested before dispatch',
    backgroundSafe: true
  },
  network: {
    status: 'available',
    tools: ['browser_network_summary', 'browser_devtools_capture', 'browser_replay_request'],
    scope: 'Resource Timing and a temporary CDP capture; request bodies are not captured',
    backgroundSafe: true
  },
  ocr: {
    status: 'available_local',
    tools: ['browser_ocr', 'browser_screenshot'],
    scope: 'Windows.Media.Ocr over a fresh viewport screenshot; text plus CSS-pixel and 0..1000 boxes, no DOM refs; the current viewport only',
    requires: 'a Windows OCR language pack; browser_ocr reports availableLanguages when the requested engine is missing',
    privacy: 'runs locally with no network, API key or downloaded weights; the temporary screenshot is mode-0600 and deleted after the call; recognized text is returned to the caller and never written to the local ledger',
    backgroundSafe: true,
    note: 'OCR reads painted pixels, including text in a canvas, image or video that the DOM cannot expose. It is evidence, not an address: a line has no ref, role or proof of clickability, so confirm its point with browser_prepare_coordinate and perform any write through browser_action_verified. Scrolled-off text is absent. The engine inserts spaces between Han glyphs; adjacent-Han spacing is compacted and other spacing is preserved.'
  },
  canvas: {
    status: 'partial',
    tools: ['browser_screenshot', 'browser_ocr', 'browser_prepare_coordinate'],
    scope: 'canvas content has no DOM children; OCR reads painted labels and coordinates reach the surface, but there is no DOM ref or semantic identity'
  },
  source: {
    status: 'available',
    tools: ['browser_script_inventory', 'browser_source_map', 'browser_debugger', 'browser_devtools_capture'],
    scope: 'runtime script inventory with sourceMappingURL, source-map parsing and generated-position lookup, breakpoints and call frames; no source editing (V8 removed setScriptSource)',
    backgroundSafe: true
  },
  eventListeners: {
    status: 'available',
    tools: ['browser_event_listeners'],
    scope: 'DOMDebugger listener inventory for one element or the document, including delegated listeners on ancestors',
    requires: 'a temporary debugger attachment, which may show Chrome\'s debugging banner',
    backgroundSafe: true
  },
  frameworkTree: {
    status: 'partial',
    tools: ['browser_framework_tree'],
    scope: 'React fiber and Vue 2/3 instance trees with component names and prop/state keys; Angular is a flat component list where only ownership is public; Svelte reports per-element source locations, not an instance tree',
    backgroundSafe: true
  }
};

const ACTION_ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'checkbox', 'radio', 'switch', 'combobox', 'treeitem']);
const FILL_TAGS = new Set(['input', 'textarea']);
const FILL_ROLES = new Set(['textbox', 'searchbox', 'spinbutton']);
const SELECT_ROLES = new Set(['combobox', 'listbox', 'option']);
const TEXT_HOLDER_TAGS = new Set(['span', 'div', 'li', 'td', 'th', 'strong', 'em', 'b', 'i', 'p', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'svg', 'path']);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const finite = value => Number.isFinite(value) ? value : null;

function rectOf(raw) {
  const source = raw.rect && typeof raw.rect === 'object' ? raw.rect : raw;
  const left = finite(source.left);
  const top = finite(source.top);
  const width = finite(source.width);
  const height = finite(source.height);
  if (left === null || top === null || width === null || height === null) return null;
  return {
    left: Math.round(left), top: Math.round(top),
    width: Math.round(width), height: Math.round(height),
    x: Math.round(left + width / 2), y: Math.round(top + height / 2)
  };
}

function roleOf(raw, tag, inputType) {
  const explicit = clean(raw.role).toLowerCase();
  if (explicit) return explicit;
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    if (inputType === 'file') return 'file';
    if (['button', 'submit', 'reset', 'image'].includes(inputType)) return 'button';
    if (inputType === 'checkbox') return 'checkbox';
    if (inputType === 'radio') return 'radio';
    return 'textbox';
  }
  return tag || null;
}

function matchKind(label, query) {
  const hay = clean(label).toLowerCase();
  const needle = clean(query).toLowerCase();
  if (!needle) return 'none';
  if (hay === needle) return 'exact';
  if (hay.startsWith(needle)) return 'prefix';
  if (hay.includes(needle)) return 'contains';
  return 'none';
}

export function decorateFrameRef(ref, frameId) {
  if (typeof ref !== 'string' || !ref) return null;
  if (!Number.isInteger(frameId) || frameId <= 0) return ref;
  if (/@frame\d+$/.test(ref)) return ref;
  return `${ref}@frame${frameId}`;
}

// A ref from any strategy is only an address while the snapshot that minted it
// is alive. Saying so on the candidate is cheaper than letting a caller find out
// through a stale_reference failure ten steps later.
function refLifetime(strategyId) {
  return strategyId === 'accessibility' ? 'none: this strategy has no action ref' : 'bounded: re-resolve after the page changes or the snapshot expires';
}

export function normalizeCandidate(raw = {}, {
  strategy = 'semantic-dom',
  frameId = 0,
  query = '',
  action = 'any'
} = {}) {
  const tag = clean(raw.tag).toLowerCase() || null;
  const rect = rectOf(raw);
  const visible = raw.visible !== false && !!rect && rect.width > 0 && rect.height > 0;
  const covered = raw.covered === true || !visible;
  const disabled = raw.disabled === true;
  const inputType = clean(raw.type || raw.inputType).toLowerCase() || null;
  const role = roleOf({ role: raw.role }, tag, inputType);
  const label = clean(raw.label || raw.text || raw.name || '');
  const matched = clean(raw.matched || label);
  const kind = matchKind(label || matched, query);
  const clickability = raw.clickability || (raw.cursorPointer === true ? 'cursor-pointer' : (raw.kind === 'clickable' ? 'cursor-pointer' : (tag === 'a' || tag === 'button' || ACTION_ROLES.has(role) ? 'semantic-control' : 'unverified')));
  const ref = decorateFrameRef(raw.ref, frameId);
  const textOnly = strategy === 'text-match' || (clickability !== 'semantic-control' && TEXT_HOLDER_TAGS.has(tag));

  const clickable = !disabled && (tag === 'a' || tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'input' || tag === 'label' || tag === 'summary'
    || ACTION_ROLES.has(role) || clickability === 'semantic-control' || clickability === 'cursor-pointer' || (visible && TEXT_HOLDER_TAGS.has(tag)));
  const isFile = inputType === 'file' || role === 'file';
  const fillable = !disabled && !isFile && ((tag === 'input' && !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'range', 'color'].includes(inputType || ''))
    || tag === 'textarea' || FILL_ROLES.has(role));
  const selectable = !disabled && (tag === 'select' || SELECT_ROLES.has(role));
  const uploadable = !disabled && isFile;

  const compatible = action === 'any'
    ? (clickable || fillable || selectable || uploadable)
    : action === 'click' ? clickable
      : action === 'fill' ? fillable
        : action === 'select' ? selectable
          : action === 'upload' ? uploadable
            : false;

  return {
    ref,
    frameId: Number.isInteger(frameId) ? frameId : 0,
    tag,
    role,
    label: label.slice(0, 500),
    matched: matched.slice(0, 500),
    matchKind: kind,
    strategy,
    strategies: [strategy],
    rect,
    visible,
    covered,
    disabled,
    clickability,
    textOnly,
    inputType,
    rowText: typeof raw.rowText === 'string' ? raw.rowText.slice(0, 500) : null,
    hitTag: raw.hitTag ?? null,
    secret: raw.secret === true,
    actionability: {
      compatible,
      clickable,
      fillable,
      selectable,
      uploadable
    },
    refLifetime: refLifetime(strategy),
    score: 0,
    confidenceLevel: 'low',
    basis: []
  };
}

function basisFor(candidate) {
  const basis = [];
  if (candidate.matchKind === 'exact') basis.push('exact_text');
  else if (candidate.matchKind === 'prefix') basis.push('prefix_text');
  else if (candidate.matchKind === 'contains') basis.push('substring_text');
  if (candidate.clickability === 'semantic-control') basis.push('semantic_control');
  if (candidate.clickability === 'cursor-pointer') basis.push('cursor_pointer_container');
  if (candidate.strategy === 'text-match') basis.push('text_holder_only');
  if (candidate.frameId > 0) basis.push('cross_frame');
  if (candidate.covered) basis.push('covered');
  if (candidate.disabled) basis.push('disabled');
  if (candidate.secret) basis.push('secret_field');
  if (!candidate.ref) basis.push('no_action_ref');
  return basis;
}

const MATCH_POINTS = { exact: 40, prefix: 32, contains: 22, none: 0 };

export function scoreCandidate(candidate) {
  let score = MATCH_POINTS[candidate.matchKind] ?? 0;
  const strategy = STRATEGY_BY_ID.get(candidate.strategy);
  score += strategy?.weight ?? 4;
  if (candidate.actionability.compatible && !candidate.covered && !candidate.disabled) score += 20;
  if (candidate.covered) score -= 30;
  if (candidate.disabled) score -= 25;
  if (candidate.textOnly) score -= 10;
  if (candidate.clickability === 'cursor-pointer') score += 4;
  if (candidate.frameId > 0) score -= 2;
  if (!candidate.visible) score -= 50;
  score = Math.max(0, Math.min(100, score));
  const confidenceLevel = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low';
  return { score, confidenceLevel, basis: basisFor(candidate) };
}

function dedupeKey(candidate) {
  const rect = candidate.rect;
  const label = candidate.label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return [candidate.frameId, candidate.tag, candidate.role, label, rect ? `${rect.left},${rect.top},${rect.width},${rect.height}` : 'no-box'].join('|');
}

// Overlap without identity is exactly the case that used to produce two
// "unique" candidates for one node: browser_find_element and browser_find_text
// mint different refs for the same element, so a caller comparing refs saw two
// targets. Merging keeps both sources and one address.
function sameNode(a, b) {
  if (a.frameId !== b.frameId || a.tag !== b.tag) return false;
  if (!a.rect || !b.rect) return false;
  const overlapX = Math.max(0, Math.min(a.rect.left + a.rect.width, b.rect.left + b.rect.width) - Math.max(a.rect.left, b.rect.left));
  const overlapY = Math.max(0, Math.min(a.rect.top + a.rect.height, b.rect.top + b.rect.height) - Math.max(a.rect.top, b.rect.top));
  const overlap = overlapX * overlapY;
  const smaller = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
  if (!smaller || overlap / smaller < 0.9) return false;
  const aLabel = a.label.toLowerCase();
  const bLabel = b.label.toLowerCase();
  return !aLabel || !bLabel || aLabel.includes(bLabel) || bLabel.includes(aLabel);
}

function mergeCandidate(target, incoming) {
  target.strategies = [...new Set([...target.strategies, ...incoming.strategies])];
  const targetWeight = STRATEGY_BY_ID.get(target.strategy)?.weight ?? 0;
  const incomingWeight = STRATEGY_BY_ID.get(incoming.strategy)?.weight ?? 0;
  if (incomingWeight > targetWeight || (incoming.tag === target.tag && !target.ref && incoming.ref)) {
    target.ref = incoming.ref ?? target.ref;
    target.strategy = incoming.strategy;
  }
  if (incoming.clickability === 'semantic-control' && target.clickability !== 'semantic-control') target.clickability = 'semantic-control';
  if (incoming.covered === false) target.covered = false;
  target.disabled = target.disabled || incoming.disabled;
  target.textOnly = target.textOnly && incoming.textOnly;
  target.actionability = {
    compatible: target.actionability.compatible || incoming.actionability.compatible,
    clickable: target.actionability.clickable || incoming.actionability.clickable,
    fillable: target.actionability.fillable || incoming.actionability.fillable,
    selectable: target.actionability.selectable || incoming.actionability.selectable,
    uploadable: target.actionability.uploadable || incoming.actionability.uploadable
  };
  if (incoming.matchKind === 'exact') target.matchKind = 'exact';
  else if (incoming.matchKind === 'prefix' && target.matchKind === 'contains') target.matchKind = 'prefix';
  if (incoming.rowText) target.rowText = incoming.rowText;
  return target;
}

export function rankCandidates(candidates) {
  const merged = [];
  for (const candidate of candidates) {
    const existing = merged.find(item => dedupeKey(item) === dedupeKey(candidate)) ?? merged.find(item => sameNode(item, candidate));
    if (existing) mergeCandidate(existing, candidate);
    else merged.push({ ...candidate, strategies: [...new Set(candidate.strategies ?? [candidate.strategy])] });
  }
  const ranked = merged.map(candidate => {
    const scored = scoreCandidate(candidate);
    return { ...candidate, ...scored };
  });
  ranked.sort((a, b) => b.score - a.score
    || (STRATEGY_BY_ID.get(b.strategy)?.weight ?? 0) - (STRATEGY_BY_ID.get(a.strategy)?.weight ?? 0)
    || a.label.localeCompare(b.label)
    || String(a.ref ?? '').localeCompare(String(b.ref ?? '')));
  return ranked;
}

export function decideLocateStatus({ candidates = [], coverage = {} } = {}) {
  if (coverage.blockedReason) return { status: 'blocked', reason: coverage.blockedReason, selection: null };
  if (coverage.unavailableReason) return { status: 'unavailable', reason: coverage.unavailableReason, selection: null };
  const viable = candidates.filter(candidate => candidate.actionability?.compatible && !candidate.covered && !candidate.disabled && candidate.ref);
  if (!viable.length) {
    if (candidates.length) return { status: coverage.complete ? 'ambiguous' : 'partial', reason: 'match_not_actionable', selection: null };
    return {
      status: coverage.complete ? 'not_found' : 'inconclusive',
      reason: coverage.complete ? 'no_match_in_complete_scope' : 'search_incomplete',
      selection: null
    };
  }
  const [top, second] = viable;
  if (viable.length === 1 && top.score >= 45) return { status: 'found', reason: 'single_actionable_match', selection: top };
  if (top.score >= 70 && (!second || second.score <= top.score - 10)) return { status: 'found', reason: 'dominant_match', selection: top };
  return {
    status: coverage.complete ? 'ambiguous' : 'partial',
    reason: second ? 'multiple_actionable_matches' : 'moderate_evidence_only',
    selection: null
  };
}

export function isLocateStatus(status) {
  return LOCATE_STATUSES.includes(status);
}

export function selectionUsable(status) {
  return NEED_REF_STATUSES.has(status);
}
