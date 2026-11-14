#!/usr/bin/env node
// Language-agnostic publish-success classifier for CSDN.
// Pure function: no network, no browser, no file IO, no Playwright, no CDP.
// It only answers: "do these observations constitute a published article?"
// See publish-contract.md §6 for the human-readable contract.

const SUCCESS_ROUTE = /\/mp_blog\/creation\/success\/(\d+)/;
const POSITIVE_TOAST = /发布成功|发布完成/;
const NEGATIVE_TOAST = /继续发布|确认发布|仍要发布|发布失败|请勿频繁|操作过于频繁/;
const EDITOR_ROUTE = /editor\.csdn\.net\/md|\/mp_blog\/creation\/editor|\/md\?articleId=/;

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * @param {object} observation
 * @param {string} [observation.url]            current page URL after the publish action
 * @param {string} [observation.toastText]      visible toast / banner text after the action
 * @param {object} [observation.saveArticle]    {code, data:{id}} from the autosave endpoint
 * @param {boolean} [observation.buttonClicked] whether a publish button was dispatched
 * @param {string} [observation.status]         caller-reported status string
 * @param {object} [observation.external]       {listPublished:boolean, publicPageHttp200:boolean}
 * @returns {{published:boolean, confidence:string, articleId:string|null,
 *            evidence:string[], rejectedSignals:string[], nextStep:string}}
 */
export function classifyPublishOutcome(observation = {}) {
  const evidence = [];
  const rejectedSignals = [];
  const url = hasText(observation.url) ? observation.url : '';
  const toast = hasText(observation.toastText) ? observation.toastText : '';
  let articleId = null;

  const routeMatch = SUCCESS_ROUTE.exec(url);
  if (routeMatch) {
    articleId = routeMatch[1];
    evidence.push('url_matches_creation_success_route');
  }

  const toastPositive = POSITIVE_TOAST.test(toast) && !NEGATIVE_TOAST.test(toast);
  if (toastPositive) evidence.push('positive_publish_toast_without_negation');
  if (POSITIVE_TOAST.test(toast) && NEGATIVE_TOAST.test(toast)) {
    rejectedSignals.push('toast_contains_negating_context');
  }

  const external = observation.external || {};
  const externalConfirmed = external.listPublished === true && external.publicPageHttp200 === true;
  if (externalConfirmed) evidence.push('creation_center_list_published_and_public_page_http_200');

  // Weak signals are explicitly rejected, never promoted.
  const save = observation.saveArticle || {};
  if (save.code === 200 || (save.data && save.data.id)) {
    rejectedSignals.push('saveArticle_200_or_draft_id_is_autosave_only');
  }
  if (observation.buttonClicked === true) rejectedSignals.push('button_dispatched_is_not_business_success');
  if (observation.status === 'success' || observation.status === 'dispatched') {
    rejectedSignals.push('caller_status_is_not_business_success');
  }
  if (EDITOR_ROUTE.test(url)) rejectedSignals.push('still_on_editor_or_draft_route');
  if (hasText(observation.savedToast)) rejectedSignals.push('editor_saved_toast_is_not_publish_success');

  const published = Boolean(routeMatch) || toastPositive || externalConfirmed;
  let confidence = 'none';
  if (routeMatch || externalConfirmed) confidence = 'high';
  else if (toastPositive) confidence = 'medium';

  let nextStep;
  if (published && confidence === 'high') {
    nextStep = 'Record the articleId and, if available, re-read the public page once. Do not dispatch another publish click.';
  } else if (published) {
    nextStep = 'Toast-only evidence is medium confidence: re-observe URL / creation-center list before declaring success. Do not replay the click.';
  } else {
    nextStep = 'No publish evidence. Re-observe the page; never replay a publish click whose outcome is unknown.';
  }

  return { published, confidence, articleId, evidence, rejectedSignals, nextStep };
}

function runSelfTest() {
  // Imports are deliberately inside the CLI branch so importing this module
  // from another snippet stays dependency-free.
  return import('node:assert/strict').then(({ default: assert }) => {
    const cases = [
      {
        name: 'success route is definitive',
        input: { url: 'https://mp.csdn.net/mp_blog/creation/success/170777271' },
        check: r => r.published === true && r.confidence === 'high' && r.articleId === '170777271'
      },
      {
        name: 'saveArticle 200 + draft id is NOT published',
        input: { url: 'https://editor.csdn.net/md/?articleId=170777124', saveArticle: { code: 200, data: { id: 170777124 } }, buttonClicked: true, status: 'success' },
        check: r => r.published === false && r.confidence === 'none' && r.rejectedSignals.length >= 4
      },
      {
        name: 'positive toast is medium confidence',
        input: { toastText: '发布成功' },
        check: r => r.published === true && r.confidence === 'medium'
      },
      {
        name: 'negating toast context is rejected',
        input: { toastText: '发布成功？请确认发布或继续发布' },
        check: r => r.published === false && r.rejectedSignals.includes('toast_contains_negating_context')
      },
      {
        name: 'external list + public page is high confidence',
        input: { external: { listPublished: true, publicPageHttp200: true } },
        check: r => r.published === true && r.confidence === 'high'
      },
      {
        name: 'partial external evidence is not enough',
        input: { external: { listPublished: true, publicPageHttp200: false } },
        check: r => r.published === false
      },
      {
        name: 'empty observation is honest unknown',
        input: {},
        check: r => r.published === false && r.confidence === 'none' && r.evidence.length === 0
      }
    ];
    for (const c of cases) {
      const result = classifyPublishOutcome(c.input);
      assert.ok(c.check(result), `${c.name}: ${JSON.stringify(result)}`);
    }
    console.log(`SELF_TEST_OK ${cases.length}/${cases.length}`);
  });
}

const isMain = process.argv[1] && /verify-success\.mjs$/.test(process.argv[1]);
if (isMain && process.argv.includes('--self-test')) {
  runSelfTest().catch(error => {
    console.error('SELF_TEST_FAILED', error.message);
    process.exitCode = 1;
  });
} else if (isMain) {
  console.log('Usage: node verify-success.mjs --self-test');
  console.log('Module export: classifyPublishOutcome(observation) — pure, no I/O.');
}
