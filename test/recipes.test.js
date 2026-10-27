// Locks the recipe rules that make replay safe to hand to a weak caller.
//
// A recipe is a flow solved once and replayed later, which means every rule here
// is about what happens when the world moved: a target that can no longer be
// found, a variable that was not supplied, a tier that matches two controls, a
// password that would otherwise be written into a JSON file on disk.
//
// The refusal cases matter more than the happy path. An automation base that
// guesses when it is unsure is worse than one that stops, because the guess is
// applied to a real account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECIPE_STEP_TOOLS, collectPlaceholders, substituteValue, missingVariables, describeProblem,
  validateRecipeSteps, buildRecipe, saveRecipe, loadRecipe, listRecipes, deleteRecipe, recipeFileName
} from '../src/recipes.js';

const target = { tag: 'input', role: null, type: 'email', name: 'Email address', id: 'user', attrName: 'email', selector: 'input#user', text: '' };
const button = { tag: 'button', role: null, type: 'submit', name: 'Sign in', id: null, attrName: null, selector: 'button', text: 'Sign in' };

const tempDir = () => mkdtempSync(join(tmpdir(), 'bridge-recipes-'));

test('placeholders are found in nested step arguments', () => {
  const found = collectPlaceholders({ text: '{{email}}', expect: { valueMatches: '{{ email }}', textAppears: 'Welcome {{name}}' } });
  assert.deepEqual([...found].sort(), ['email', 'name']);
});

test('substitution replaces every occurrence and reports what it could not fill', () => {
  const { value, missing } = substituteValue({ text: '{{email}}', expect: { textAppears: 'Hi {{nickname}}' } }, { email: 'a@b.test' });
  assert.equal(value.text, 'a@b.test');
  // The unfilled placeholder stays visible rather than becoming an empty
  // string: a blank field submits and fails on the server, which is worse.
  assert.equal(value.expect.textAppears, 'Hi {{nickname}}');
  assert.deepEqual(missing, ['nickname']);
});

test('an empty variable counts as missing, not as an empty string', () => {
  const recipe = { variables: ['email'], steps: [{ tool: 'browser_fill', target, text: '{{email}}' }] };
  assert.deepEqual(missingVariables(recipe, { email: '' }), ['email']);
  assert.deepEqual(missingVariables(recipe, { email: 'a@b.test' }), []);
});

test('missing variables include ones declared but never used in a step', () => {
  const recipe = { variables: ['email', 'password'], steps: [{ tool: 'browser_fill', target, text: '{{email}}' }] };
  assert.deepEqual(missingVariables(recipe, { email: 'a@b.test' }), ['password']);
});

test('a target with no durable identity is refused', () => {
  assert.match(describeProblem({ tag: 'input' }), /no durable identity/);
  assert.match(describeProblem({ name: 'Email address' }), /no tag/);
  assert.match(describeProblem(null), /not an object/);
  assert.equal(describeProblem(target), null);
});

test('a step using a tool that cannot be re-resolved is refused', () => {
  for (const tool of ['browser_navigate', 'browser_upload', 'browser_action', 'browser_key', 'browser_storage_write']) {
    const result = validateRecipeSteps([{ tool, target }]);
    assert.equal(result.ok, false, tool);
    assert.equal(result.reason, 'step_tool_not_replayable', tool);
  }
  for (const tool of RECIPE_STEP_TOOLS) {
    const result = validateRecipeSteps([{ tool, target }]);
    assert.equal(result.ok, true, tool);
  }
});

test('a secret step may not store a literal password', () => {
  const literal = validateRecipeSteps([{ tool: 'browser_fill', target, secret: true, text: 'hunter2' }]);
  assert.equal(literal.ok, false);
  assert.equal(literal.reason, 'secret_value_not_storable');
  assert.match(literal.message, /never contain a password/);
  // Mixed literal plus placeholder is the sneaky case: the placeholder is there,
  // so a naive check would pass it and still write the literal half.
  const mixed = validateRecipeSteps([{ tool: 'browser_fill', target, secret: true, text: 'hunter2{{tail}}' }]);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.reason, 'secret_value_not_storable');
  const placeholderOnly = validateRecipeSteps([{ tool: 'browser_fill', target, secret: true, text: '{{password}}' }]);
  assert.equal(placeholderOnly.ok, true);
});

test('a secret step with no text at all is refused too', () => {
  // secret with no placeholder means the recipe records a secret step it can
  // never fill, which would fail at run time instead of at save time.
  const result = validateRecipeSteps([{ tool: 'browser_fill', target, secret: true }]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'secret_value_not_storable');
});

test('a step may not carry its own confirmation', () => {
  const result = validateRecipeSteps([{ tool: 'browser_click', target, confirmation: 'run_recipe_once' }]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'step_carries_confirmation');
  assert.match(result.message, /one approval/);
});

test('tabId and agent are stripped from a step and reported', () => {
  const result = validateRecipeSteps([{ tool: 'browser_click', target, tabId: 42, agent: 'someone' }]);
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.steps[0], 'tabId'), false);
  assert.equal(Object.hasOwn(result.steps[0], 'agent'), false);
  assert.deepEqual(result.stripped, [{ step: 1, key: 'tabId' }, { step: 1, key: 'agent' }]);
});

test('the tool argument survives validation and is kept flat', () => {
  const result = validateRecipeSteps([{ tool: 'browser_fill_verified', target, text: '{{email}}', expect: { valueMatches: '{{email}}' } }]);
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].tool, 'browser_fill_verified');
  assert.equal(result.steps[0].text, '{{email}}');
  assert.deepEqual(result.steps[0].expect, { valueMatches: '{{email}}' });
  assert.equal(Object.hasOwn(result.steps[0], 'args'), false);
});

test('an empty or oversized recipe is refused', () => {
  assert.equal(validateRecipeSteps([]).reason, 'recipe_needs_steps');
  assert.equal(validateRecipeSteps(undefined).reason, 'recipe_needs_steps');
  const many = Array.from({ length: 41 }, () => ({ tool: 'browser_click', target }));
  assert.equal(validateRecipeSteps(many).reason, 'recipe_too_long');
});

test('buildRecipe derives the variable list from the steps themselves', () => {
  const built = buildRecipe({ name: 'login', steps: [
    { tool: 'browser_fill', target, text: '{{email}}' },
    { tool: 'browser_fill', target, secret: true, text: '{{password}}' }
  ] });
  assert.equal(built.ok, true);
  assert.deepEqual(built.recipe.variables, ['email', 'password']);
  assert.equal(built.recipe.version, 1);
});

test('recipe names cannot escape the recipe directory', () => {
  assert.equal(recipeFileName('../etc/passwd'), null);
  assert.equal(recipeFileName('a/b'), null);
  assert.equal(recipeFileName(''), null);
  assert.equal(recipeFileName('..'), null);
  assert.equal(recipeFileName('acme-login'), 'acme-login.json');
});

test('save, load, list and delete round-trip on disk', () => {
  const dir = tempDir();
  try {
    const built = buildRecipe({ name: 'acme-login', origin: 'https://acme.test', note: 'two-step', steps: [{ tool: 'browser_click', target: button }] });
    const saved = saveRecipe(dir, built.recipe);
    assert.equal(saved.ok, true);
    // 0600: a recipe describes how to drive a site and should not be
    // world-readable. Windows ignores POSIX modes on write, so the property is
    // only assertable on a POSIX host; the code still asks for 0600 either way.
    if (process.platform !== 'win32') assert.equal(statSync(saved.path).mode & 0o777, 0o600);

    const loaded = loadRecipe(dir, 'acme-login');
    assert.equal(loaded.ok, true);
    assert.equal(loaded.recipe.origin, 'https://acme.test');
    assert.equal(loaded.recipe.steps[0].target.name, 'Sign in');

    const listed = listRecipes(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'acme-login');
    assert.equal(listed[0].stepCount, 1);

    assert.equal(deleteRecipe(dir, 'acme-login').ok, true);
    assert.equal(listRecipes(dir).length, 0);
    assert.equal(deleteRecipe(dir, 'acme-login').reason, 'recipe_not_found');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loading an unknown recipe names the ones that do exist', () => {
  const dir = tempDir();
  try {
    saveRecipe(dir, buildRecipe({ name: 'known', steps: [{ tool: 'browser_click', target: button }] }).recipe);
    const missing = loadRecipe(dir, 'unknown');
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'recipe_not_found');
    assert.deepEqual(missing.known, ['known']);
    assert.match(missing.message, /Known recipes: known/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable file is reported instead of breaking the listing', () => {
  const dir = tempDir();
  try {
    saveRecipe(dir, buildRecipe({ name: 'good', steps: [{ tool: 'browser_click', target: button }] }).recipe);
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    const listed = listRecipes(dir);
    assert.equal(listed.length, 2);
    assert.equal(listed.find(item => item.name === 'broken').unreadable, true);
    assert.equal(listed.find(item => item.name === 'good').stepCount, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a recipe written by another version is refused, not guessed at', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'old.json'), JSON.stringify({ version: 0, name: 'old', steps: [{ tool: 'browser_click', target: button }] }));
    const loaded = loadRecipe(dir, 'old');
    assert.equal(loaded.ok, false);
    assert.equal(loaded.reason, 'recipe_version_unsupported');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
