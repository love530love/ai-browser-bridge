// Recipes: a flow that a stronger agent already worked out once, stored as data
// and replayed deterministically.
//
// The reason this exists is the gap between a good agent and a weak one. A good
// agent can look at a page and decide what to click; a weak one cannot, and no
// amount of better error messages fixes that. What does fix it is not asking the
// weak agent to decide again: the flow is decided once, stored, and replayed
// step by step with a target descriptor that survives the ref, the build hash and
// the framework's regenerated ids.
//
// This is the same idea as browser-use's history replay (MIT) and Healenium's
// self-healing locators (Apache-2.0), reimplemented in this project's terms. No
// code is copied: the descriptor tiers, the refusal rules and the failure shape
// are all ours, because the safety property we need is different. Those tools
// heal a test suite and report a pass; this one must never guess, because a
// wrong guess here types a password into the wrong field or clicks Pay.
//
// Three rules are enforced here rather than left to the caller:
//   1. A secret step may not store a literal. A recipe file that contains a
//      password turns a convenience feature into a plaintext credential store.
//   2. Every placeholder must be supplied before step 1 runs. A typo must not
//      produce a half-executed flow.
//   3. A tier that matches more than one visible element is refused, not
//      resolved by position. Ambiguity is where automation gets dangerous.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const RECIPE_VERSION = 1;
export const MAX_RECIPE_STEPS = 40;
export const RECIPE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Only DOM tools with an explicit target. Deliberately excluded: navigation
// (a recipe that navigates can leave the origin it was recorded on), upload
// (needs a local file path that belongs to the caller, not to the recipe) and
// every coordinate/desktop path (those cannot be re-resolved by identity).
export const RECIPE_STEP_TOOLS = ['browser_click', 'browser_click_verified', 'browser_fill', 'browser_fill_verified', 'browser_select', 'browser_choose', 'browser_pick'];
const STEP_ONLY_ARGS = new Set(['tool', 'ref', 'target', 'secret']);
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]{1,40})\s*\}\}/g;

export function recipeFileName(name) {
  return typeof name === 'string' && RECIPE_NAME.test(name) ? `${name}.json` : null;
}

export function recipeDir(root) {
  return join(root, 'recipes');
}

// Walks any JSON-ish value and collects the placeholders it mentions.
export function collectPlaceholders(value, found = new Set()) {
  if (typeof value === 'string') {
    PLACEHOLDER.lastIndex = 0;
    let match;
    while ((match = PLACEHOLDER.exec(value)) !== null) found.add(match[1]);
    return found;
  }
  if (Array.isArray(value)) { for (const item of value) collectPlaceholders(item, found); return found; }
  if (value && typeof value === 'object') { for (const item of Object.values(value)) collectPlaceholders(item, found); return found; }
  return found;
}

// Substitutes placeholders everywhere in a step's arguments. Returns what is
// missing instead of substituting an empty string: a silently blank field is
// worse than a refusal, because the submit goes through and fails on the server.
export function substituteValue(value, variables = {}) {
  const missing = new Set();
  const walk = input => {
    if (typeof input === 'string') {
      return input.replace(PLACEHOLDER, (whole, key) => {
        if (!Object.hasOwn(variables, key) || variables[key] === null || variables[key] === undefined) { missing.add(key); return whole; }
        return String(variables[key]);
      });
    }
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(input)) out[key] = walk(item);
      return out;
    }
    return input;
  };
  return { value: walk(value), missing: [...missing] };
}

export function missingVariables(recipe, variables = {}) {
  const needed = new Set(recipe?.variables ?? []);
  for (const step of recipe?.steps ?? []) collectPlaceholders(step, needed);
  return [...needed].filter(name => !Object.hasOwn(variables, name) || variables[name] === null || variables[name] === undefined || String(variables[name]).length === 0);
}

// A descriptor has to carry at least one durable identity. Without one the step
// would replay by position, which is exactly the failure mode this feature
// exists to remove.
export function describeProblem(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return 'target is not an object';
  const usable = ['name', 'id', 'attrName', 'selector', 'text'].filter(key => typeof target[key] === 'string' && target[key].trim().length > 0);
  if (!usable.length) return 'target carries no durable identity (name, id, attrName, selector or text)';
  if (!target.tag) return 'target has no tag, so shape cannot be checked';
  return null;
}

// Runs on the extension's describe output, before anything is written to disk.
export function validateRecipeSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, reason: 'recipe_needs_steps', message: 'A recipe needs at least one step.' };
  if (steps.length > MAX_RECIPE_STEPS) return { ok: false, reason: 'recipe_too_long', message: `A recipe may have at most ${MAX_RECIPE_STEPS} steps; this one has ${steps.length}.` };
  const cleaned = [];
  const stripped = [];
  for (const [index, step] of steps.entries()) {
    const at = index + 1;
    if (!step || typeof step !== 'object' || Array.isArray(step)) return { ok: false, reason: 'step_not_an_object', message: `Step ${at} is not an object.` };
    if (!RECIPE_STEP_TOOLS.includes(step.tool)) {
      return { ok: false, reason: 'step_tool_not_replayable', step: at,
        message: `Step ${at} uses ${JSON.stringify(step.tool)}. A recipe can only replay ${RECIPE_STEP_TOOLS.join(', ')}: those are the tools whose target can be re-resolved by identity.` };
    }
    const problem = describeProblem(step.target);
    if (problem) return { ok: false, reason: 'step_target_not_durable', step: at, message: `Step ${at}: ${problem}.` };
    if (Object.hasOwn(step, 'confirmation')) {
      return { ok: false, reason: 'step_carries_confirmation', step: at,
        message: `Step ${at} carries its own confirmation. Confirmation belongs to the run call, so one approval cannot authorise an arbitrary number of recorded steps.` };
    }
    const args = {};
    for (const [key, value] of Object.entries(step)) {
      if (STEP_ONLY_ARGS.has(key)) continue;
      // tabId and agent belong to the caller and the run, not to the recipe: a
      // recorded tab id would point at a tab that no longer exists.
      if (key === 'tabId' || key === 'agent') { stripped.push({ step: at, key }); continue; }
      args[key] = value;
    }
    if (step.secret === true) {
      const placeholders = [...collectPlaceholders(args)];
      const text = typeof args.text === 'string' ? args.text : null;
      const literalText = text !== null && text.replace(PLACEHOLDER, '').trim().length > 0;
      if (literalText || placeholders.length === 0) {
        return { ok: false, reason: 'secret_value_not_storable', step: at,
          message: `Step ${at} is marked secret but its text is a literal or is not a placeholder. A recipe file must never contain a password: write text as "{{yourVariableName}}" and pass the value in variables at run time.` };
      }
    }
    // Flat, not nested under an `args` key: the run side hands the same object to
    // the same tool, so any reshaping here would be a translation layer that can
    // drift from the tool schema.
    cleaned.push({ tool: step.tool, target: step.target, ...(step.secret === true ? { secret: true } : {}), ...args });
  }
  return { ok: true, steps: cleaned, stripped };
}

export function buildRecipe({ name, origin = null, note = null, steps, variables = [] }) {
  const validated = validateRecipeSteps(steps);
  if (!validated.ok) return validated;
  const declared = new Set(variables);
  for (const step of validated.steps) collectPlaceholders(step, declared);
  const recipe = {
    version: RECIPE_VERSION,
    name,
    origin: typeof origin === 'string' && origin ? origin : null,
    note: typeof note === 'string' ? note.slice(0, 500) : null,
    variables: [...declared].sort(),
    steps: validated.steps,
    savedAt: new Date().toISOString()
  };
  return { ok: true, recipe, stripped: validated.stripped };
}

export function saveRecipe(dir, recipe) {
  const fileName = recipeFileName(recipe?.name);
  if (!fileName) return { ok: false, reason: 'invalid_recipe_name', message: 'Recipe names must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.' };
  mkdirSync(dir, { recursive: true });
  const target = join(dir, fileName);
  const temp = `${target}.${process.pid}.tmp`;
  // 0600: a recipe describes how to drive a site, which is worth keeping away
  // from other local users even though it holds no secret.
  writeFileSync(temp, `${JSON.stringify(recipe, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
  return { ok: true, path: target, bytes: JSON.stringify(recipe).length };
}

export function loadRecipe(dir, name) {
  const fileName = recipeFileName(name);
  if (!fileName) return { ok: false, reason: 'invalid_recipe_name' };
  const path = join(dir, fileName);
  if (!existsSync(path)) {
    const known = listRecipes(dir).map(item => item.name);
    return { ok: false, reason: 'recipe_not_found', known, message: known.length
      ? `No recipe named ${JSON.stringify(name)}. Known recipes: ${known.join(', ')}.`
      : `No recipe named ${JSON.stringify(name)}, and no recipes are saved yet. Save one with browser_recipe_save after completing the flow once.` };
  }
  try {
    const recipe = JSON.parse(readFileSync(path, 'utf8'));
    if (recipe?.version !== RECIPE_VERSION) return { ok: false, reason: 'recipe_version_unsupported', message: `Recipe version ${recipe?.version} is not ${RECIPE_VERSION}. Record it again.` };
    if (!Array.isArray(recipe.steps) || !recipe.steps.length) return { ok: false, reason: 'recipe_has_no_steps' };
    return { ok: true, recipe, path };
  } catch (error) {
    return { ok: false, reason: 'recipe_unreadable', message: String(error?.message ?? error).slice(0, 200) };
  }
}

export function listRecipes(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith('.json')) continue;
    try {
      const recipe = JSON.parse(readFileSync(join(dir, fileName), 'utf8'));
      out.push({ name: recipe.name ?? fileName.replace(/\.json$/, ''), origin: recipe.origin ?? null, note: recipe.note ?? null, variables: recipe.variables ?? [], stepCount: recipe.steps?.length ?? 0, savedAt: recipe.savedAt ?? null });
    } catch {
      // A half-written or hand-edited file must not hide the others.
      out.push({ name: fileName.replace(/\.json$/, ''), unreadable: true });
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function deleteRecipe(dir, name) {
  const fileName = recipeFileName(name);
  if (!fileName) return { ok: false, reason: 'invalid_recipe_name' };
  const path = join(dir, fileName);
  if (!existsSync(path)) return { ok: false, reason: 'recipe_not_found' };
  unlinkSync(path);
  return { ok: true, path };
}
