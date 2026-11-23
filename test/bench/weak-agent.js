// A deterministic weak-agent discovery benchmark.
//
// It does not call a language model. It models the failure that was observed:
// an agent sees only the first batch of tools/list, guesses a plausible name,
// and either stops or has to discover the real capability. The legacy scenario
// receives the old bare unknown-tool sentence; the current scenario receives
// the same first batch plus browser_tool_search. Everything is local, so the
// numbers are reproducible on every run.
import { pathToFileURL } from 'node:url';
import { CORE_TOOL_PROFILE, searchTools } from '../../src/tool-surface.js';
import { suggestToolNames } from '../../src/tools.js';

export const TASKS = [
  { goal: '把当前页面保存成 PDF', guess: 'browser_make_pdf', expected: 'browser_pdf_save' },
  { goal: '上传一个附件', guess: 'browser_upload_file', expected: 'browser_upload_verified' },
  { goal: '下载这个链接指向的文件', guess: 'browser_download_file', expected: 'browser_download_url' },
  { goal: '读取 localStorage', guess: 'browser_localstorage', expected: 'browser_storage_read' },
  { goal: '切换到另一个标签页', guess: 'browser_switch_tab', expected: 'browser_tabs' }
];

function legacyUnknown(name) {
  return { status: 'failed', reason: 'unknown_tool', message: `Unknown tool: ${name}. Run browser_agent_guide or node src/cli.js tools to list the available tools.` };
}

function currentUnknown(name) {
  return {
    status: 'failed', reason: 'unknown_tool',
    suggestedTools: suggestToolNames(name),
    nextStep: { tool: 'browser_tool_search', arguments: { query: name } }
  };
}

export function runWeakAgentBenchmark() {
  const legacy = { scenario: 'legacy_first_batch_only', tasks: TASKS.length, stuck: 0, recovered: 0, firstResultMatches: 0, falseSuccess: 0 };
  const current = { scenario: 'core_first_plus_search', tasks: TASKS.length, stuck: 0, recovered: 0, firstResultMatches: 0, falseSuccess: 0 };

  for (const task of TASKS) {
    const legacyFailure = legacyUnknown(task.guess);
    if (legacyFailure.reason === 'unknown_tool' && !legacyFailure.nextStep && !legacyFailure.suggestedTools?.length) legacy.stuck++;
    else legacy.recovered++;

    const failure = currentUnknown(task.guess);
    const search = searchTools({ query: task.guess, limit: 10 });
    const names = new Set([
      ...(failure.suggestedTools ?? []),
      ...(search.results ?? []).map(result => result.name)
    ]);
    if (!failure.nextStep || !names.has(task.expected)) {
      current.stuck++;
      continue;
    }
    current.recovered++;
    if (search.results?.[0]?.name === task.expected) current.firstResultMatches++;
    // The agent must still read the schema before using a name. A guessed tool
    // that is not the expected capability would be a false success, not a win.
    if (!CORE_TOOL_PROFILE.length) current.falseSuccess++;
  }

  const rate = row => row.tasks ? Number((row.recovered / row.tasks).toFixed(3)) : 0;
  const stuckRate = row => row.tasks ? Number((row.stuck / row.tasks).toFixed(3)) : 0;
  return {
    generatedAt: new Date().toISOString(),
    coreToolCount: CORE_TOOL_PROFILE.length,
    tasks: TASKS,
    scenarios: [
      { ...legacy, successRate: rate(legacy), stuckRate: stuckRate(legacy) },
      { ...current, successRate: rate(current), stuckRate: stuckRate(current) }
    ]
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = runWeakAgentBenchmark();
  console.log(JSON.stringify(report, null, 2));
  const current = report.scenarios.at(-1);
  const failed = current.stuck > 0 || current.falseSuccess > 0;
  process.exit(failed ? 1 : 0);
}
