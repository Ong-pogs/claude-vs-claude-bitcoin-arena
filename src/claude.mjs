// One clean Claude Code call. The same command for every version; only --model and --effort differ.
//
//   claude -p --model <model> --effort <effort> --system-prompt "<fixed text>" --tools "" --safe-mode
//          --setting-sources "" --strict-mcp-config --disable-slash-commands --no-session-persistence
//          --output-format stream-json --verbose            (prompt on stdin, run from an empty folder)
//
// --tools ""            no tools at all
// --safe-mode           no CLAUDE.md, skills, installed plugins, hooks, MCP servers, custom commands or agents
// --setting-sources ""  no user, project or local settings files (so no saved model, effort or permission settings)
// --strict-mcp-config   no MCP servers from any other configuration
// --no-session-persistence   nothing is saved, so no round can see an earlier one
// CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1   stops Claude Code attaching a second, stronger model as an "advisor"
// Every CLAUDE*, ANTHROPIC* and AI_AGENT environment variable of the parent is removed first.
// The call uses the normal Claude Code login (--bare would not), so it runs on the owner's Claude plan.
import {spawn, execFileSync} from 'node:child_process';
import {createWriteStream, mkdirSync} from 'node:fs';
import path from 'node:path';

export function resolveClaude(command = 'claude') {
  if (path.isAbsolute(command)) return command;
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], {encoding: 'utf8', windowsHide: true}).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return found.find(f => /\.exe$/i.test(f)) || found[0] || command;
  } catch { return command; }
}

export function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC|AI_AGENT)/i.test(key)) env[key] = value;
  return {...env, ...extra};
}

export function buildArgs({model, effort, system, flags}) {
  return ['-p', '--model', model, '--effort', effort, '--system-prompt', system, ...flags];
}

// The command as a person would type it, for the notes, the dashboard and the README.
export function commandLine({model = '<model>', effort = '<effort>', flags, env = {}}) {
  const quote = a => (a === '' ? '""' : /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const envPart = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
  return `${envPart ? envPart + ' ' : ''}claude -p --model ${model} --effort ${effort} --system-prompt "<the fixed system prompt>" ${flags.map(quote).join(' ')} < prompt.txt`;
}

const LIMIT_TEXT = /usage limit|rate.?limit|limit reached|hit your (session |weekly |usage )?limit|out of (extra )?usage|quota|too many requests|429/i;

// Runs one call and resolves with a record. Never rejects.
// deadlineMs: wall-clock time after which the process is killed and the call is a timeout.
// onAnswer(record) fires the moment the result line arrives, before the process has finished exiting.
export function callClaude({exe, contestant, system, prompt, flags, extraEnv, cwd, deadlineMs, rawFile, roundStartMs, onAnswer}) {
  return new Promise(resolve => {
    const args = buildArgs({model: contestant.model, effort: contestant.effort, system, flags});
    const record = {
      id: contestant.id, model: contestant.model, effort: contestant.effort,
      spawnedAtMs: Date.now(), firstOutputAtMs: null, answerAtMs: null, exitAtMs: null, exitCode: null,
      status: 'pending', statusDetail: null, text: null, init: null, result: null, rateLimit: null, limitStatuses: [], otherEvents: [], assistantModels: [], checks: null, stderr: '',
    };
    let raw = null;
    if (rawFile) { mkdirSync(path.dirname(rawFile), {recursive: true}); raw = createWriteStream(rawFile); }
    let child;
    try {
      child = spawn(exe, args, {cwd, env: cleanEnv(extraEnv), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    } catch (e) {
      record.status = 'error'; record.statusDetail = `could not start claude: ${e.message}`; record.exitAtMs = Date.now();
      raw?.end(); return resolve(finish(record, roundStartMs));
    }
    record.pid = child.pid;
    let buffer = '', settled = false, killedForDeadline = false;
    const timer = setTimeout(() => { killedForDeadline = true; killTree(child); }, Math.max(0, deadlineMs - Date.now()));
    const onLine = line => {
      if (!line.trim()) return;
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'system' && event.subtype === 'init') {
        record.init = {model: event.model, tools: event.tools, mcpServers: event.mcp_servers, slashCommands: event.slash_commands, skills: event.skills, agents: event.agents, plugins: (event.plugins || []).map(p => p.source || p.name), permissionMode: event.permissionMode, apiKeySource: event.apiKeySource, version: event.claude_code_version, cwd: event.cwd};
      } else if (event.type === 'assistant') {
        const model = event.message?.model; if (model && !record.assistantModels.includes(model)) record.assistantModels.push(model);
      } else if (event.type === 'rate_limit_event') {
        record.rateLimit = event.rate_limit_info || null;
        const status = event.rate_limit_info?.status; if (status && !record.limitStatuses.includes(status)) record.limitStatuses.push(status);
      } else if (event.type === 'system' && event.subtype !== 'init') {
        // Retries and other notices from Claude Code itself, kept so a stalled call can be told apart from a slow model.
        if (record.otherEvents.length < 20) record.otherEvents.push(JSON.stringify(event).slice(0, 400));
      } else if (event.type === 'result') {
        record.answerAtMs = Date.now();
        record.result = {
          isError: !!event.is_error, subtype: event.subtype, apiErrorStatus: event.api_error_status ?? null, terminalReason: event.terminal_reason ?? null,
          numTurns: event.num_turns, durationMs: event.duration_ms, durationApiMs: event.duration_api_ms, ttftMs: event.ttft_ms, timeToRequestMs: event.time_to_request_ms,
          usage: event.usage ? {inputTokens: event.usage.input_tokens, cacheCreationTokens: event.usage.cache_creation_input_tokens, cacheReadTokens: event.usage.cache_read_input_tokens, outputTokens: event.usage.output_tokens, thinkingTokens: event.usage.output_tokens_details?.thinking_tokens ?? null, webSearchRequests: event.usage.server_tool_use?.web_search_requests ?? 0, webFetchRequests: event.usage.server_tool_use?.web_fetch_requests ?? 0, iterations: event.usage.iterations?.length ?? null} : null,
          modelUsage: event.modelUsage ? Object.fromEntries(Object.entries(event.modelUsage).map(([m, u]) => [m, {inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadInputTokens, cacheCreationTokens: u.cacheCreationInputTokens, thinkingTokens: u.thinkingTokens ?? null, listPriceUsd: u.costUSD}])) : null,
          listPriceUsd: event.total_cost_usd ?? null,
        };
        record.text = typeof event.result === 'string' ? event.result : null;
        record.answerSeconds = roundStartMs != null ? Math.round((record.answerAtMs - roundStartMs) / 10) / 100 : null;
        if (onAnswer && !record.result.isError && record.text != null) { try { onAnswer(record); } catch {} }
      }
    };
    child.stdout.on('data', chunk => {
      if (!record.firstOutputAtMs) record.firstOutputAtMs = Date.now();
      raw?.write(chunk);
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) { onLine(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
    });
    child.stderr.on('data', chunk => { if (record.stderr.length < 4000) record.stderr += chunk.toString('utf8'); });
    child.on('error', e => { if (settled) return; settled = true; clearTimeout(timer); record.status = 'error'; record.statusDetail = `could not run claude: ${e.message}`; record.exitAtMs = Date.now(); raw?.end(); resolve(finish(record, roundStartMs)); });
    child.on('close', code => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (buffer.trim()) onLine(buffer);
      record.exitAtMs = Date.now(); record.exitCode = code; raw?.end();
      classify(record, killedForDeadline);
      resolve(finish(record, roundStartMs));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {windowsHide: true, stdio: 'ignore'});
    else child.kill('SIGKILL');
  } catch { try { child.kill(); } catch {} }
}

function classify(record, killedForDeadline) {
  const r = record.result;
  const limitStatus = record.rateLimit?.status;
  if (r && !r.isError && r.subtype === 'success' && record.text != null) { record.status = 'ok'; }
  else if (killedForDeadline && !r) {
    // A call that was still waiting on a plan limit or an API retry when time ran out was not slow thinking.
    const notices = record.otherEvents.join(' ');
    const limited = record.limitStatuses.some(x => !/^allowed/.test(x)) || LIMIT_TEXT.test(notices);
    const retried = /retry|overloaded|5dd/i.test(notices);
    if (limited) { record.status = 'blocked'; record.statusDetail = `blocked by the Claude plan's limit and still waiting at the deadline (${record.limitStatuses.join(', ') || 'retry notices'})`; }
    else if (retried) { record.status = 'error'; record.statusDetail = `Claude Code was retrying a failed request at the deadline: ${notices.slice(0, 160)}`; }
    else { record.status = 'timeout'; record.statusDetail = 'no answer by the deadline; the call was stopped'; }
  }
  else if ((r && (r.apiErrorStatus === 429 || LIMIT_TEXT.test(record.text || ''))) || (limitStatus && !/^allowed/.test(limitStatus)) || LIMIT_TEXT.test(record.stderr || '')) {
    record.status = 'blocked'; record.statusDetail = `blocked by the Claude plan's limit: ${(record.text || record.stderr || limitStatus || '').slice(0, 200)}`;
  } else {
    record.status = 'error';
    record.statusDetail = r ? `Claude Code reported an error (${r.subtype}${r.apiErrorStatus ? ', API status ' + r.apiErrorStatus : ''}): ${(record.text || '').slice(0, 200)}` : `claude exited with code ${record.exitCode} and no result: ${record.stderr.slice(0, 200)}`;
  }
  // Proof that this call was the version asked for and that nothing leaked in.
  const models = r?.modelUsage ? Object.keys(r.modelUsage) : [];
  const builtin = p => /@builtin$/.test(p);
  record.checks = {
    modelReported: models.join(', ') || record.init?.model || null,
    modelMatches: record.init?.model === record.model && (models.length === 0 ? record.status !== 'ok' : models.length === 1 && models[0] === record.model) && record.assistantModels.every(m => m === record.model),
    noTools: Array.isArray(record.init?.tools) && record.init.tools.length === 0,
    noMcp: Array.isArray(record.init?.mcpServers) && record.init.mcpServers.length === 0,
    noSkillsOrCommands: (record.init?.skills || []).length === 0 && (record.init?.slashCommands || []).length === 0,
    onlyBuiltinPlugins: (record.init?.plugins || []).every(builtin),
    oneTurn: r ? r.numTurns === 1 : null,
    noServerTools: r?.usage ? r.usage.webSearchRequests === 0 && r.usage.webFetchRequests === 0 : null,
  };
  if (record.status === 'ok') {
    const failed = Object.entries(record.checks).filter(([k, v]) => k !== 'modelReported' && v === false).map(([k]) => k);
    if (failed.length) { record.status = 'error'; record.statusDetail = `the call was not clean (${failed.join(', ')}); model reported: ${record.checks.modelReported}`; }
  }
}

function finish(record, roundStartMs) {
  const end = record.answerAtMs ?? record.exitAtMs;
  record.answerSeconds = record.answerAtMs != null && roundStartMs != null ? Math.round((record.answerAtMs - roundStartMs) / 10) / 100 : null;
  record.wallSeconds = end != null ? Math.round((end - record.spawnedAtMs) / 10) / 100 : null;
  return record;
}
