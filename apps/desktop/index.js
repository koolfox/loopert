import { runPocSession } from '@loopert/core';
import fs from 'fs';
import http from 'http';
import yaml from 'js-yaml';
import { stdin as input, stdout as output } from 'node:process';
import { spawnSync } from 'child_process';
import { chromium } from 'playwright';
import readline from 'readline/promises';

function parseArgs(rawArgs) {
  const args = [];
  const flags = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('--')) {
      const [key, value] = arg.includes('=')
        ? arg.slice(2).split('=')
        : [arg.slice(2), rawArgs[i + 1] && !rawArgs[i + 1].startsWith('--') ? rawArgs[++i] : true];
      flags[key] = value;
    } else {
      args.push(arg);
    }
  }
  return { positional: args, flags };
}

const DEFAULTS = {
  model: process.env.OLLAMA_MODEL,
  host: process.env.OLLAMA_HOST,
  profile: 'default',
  headless: false,
  devtools: false,
  cookieDismiss: false,
  autoApprove: false,
  Config: 'guardrails.yaml',
  llmLog: 'snippet', // snippet | full | off
  repl: true,
  manualDefault: true,
  disableTestSite: false,
  workspace: 'loopert-workspace',
  executor: 'browser-use', // browser-use | playwright
  keepOpen: false,
  fallbackPlaywright: false
};

function loadCliConfig(path) {
  if (!fs.existsSync(path)) return {};
  try {
    const raw = fs.readFileSync(path, 'utf8');
    const parsed = yaml.load(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn(`Warning: could not load config file ${path}: ${err.message}`);
    return {};
  }
}

function printHelp() {
  console.log(`Loopert POC CLI
Usage:
  node apps/desktop/index.js [goal text] [options]

Options:
  --headless           Run browser headless (default: false)
  --devtools           Open Chromium with DevTools (headful only)
  --stub-plan          Use deterministic local test-site plan (skips LLM)
  --cookie-dismiss     Best-effort auto-dismiss common cookie popups after navigate
  --model <name>       Ollama model name (default: env OLLAMA_MODEL or llama3.1)
  --host <url>         Ollama host (default: env OLLAMA_HOST)
  --profile <name>     Guardrail profile (default: default)
  --config <path>      Path to guardrails YAML (default: guardrails.yaml)
  --prompt-variant <computer|mobile|grounding>  Force planner prompt style
  --workspace <path>   Sandbox root for file/shell tools (default: loopert-workspace)
  --executor <browser-use|playwright>  Choose executor (default: browser-use)
  --keep-open          Do not close Playwright browser after execution (debug/manual follow-up)
  --fallback-playwright Allow Playwright fallback if browser-use fails (default: false)
  --cli-config <path>  Path to CLI config.yaml (default: config.yaml)
  --plan <path>        Precomputed JSON plan file (bypasses planner)
  --repl               Chat-style loop: enter goals repeatedly until blank line
  --verbose-llm        Print full LLM raw response (default: snippet)
  --no-llm-log         Do not print LLM raw response
  --yes                Auto-approve plan and origin prompts
  --help               Show this help

Examples:
  npm run desktop
  node apps/desktop/index.js "Navigate to https://duckduckgo.com/?q=OpenAI, wait_for_idle for 1200ms, snapshot."
  node apps/desktop/index.js --plan google-search-plan.json --profile pro --yes
`);
}

function buildStubPlan(url) {
  return {
    plan_id: `stub-${Date.now()}`,
    autonomy_level: 'assisted',
    reasoning_summary: 'Deterministic stub plan for local test site',
    steps: [
      {
        tool: 'navigate',
        args: { url },
        explanation: 'open local test page',
        estimated_risk: 'low',
        confidence: 0.95
      },
      {
        tool: 'type',
        args: { id: 'name', text: 'Jane Doe' },
        explanation: 'fill name',
        estimated_risk: 'low',
        confidence: 0.9
      },
      {
        tool: 'type',
        args: { id: 'email', text: 'jane@example.com' },
        explanation: 'fill email',
        estimated_risk: 'low',
        confidence: 0.9
      },
      {
        tool: 'click',
        args: { id: 'submit' },
        explanation: 'submit form',
        estimated_risk: 'low',
        confidence: 0.9
      },
      {
        tool: 'wait_for_idle',
        args: { timeoutMs: 800 },
        explanation: 'wait for UI update',
        estimated_risk: 'low',
        confidence: 0.85
      },
      {
        tool: 'snapshot',
        args: {},
        explanation: 'capture proof of action',
        estimated_risk: 'low',
        confidence: 0.95
      }
    ]
  };
}

function createTestPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Loopert POC Test Site</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; max-width: 720px; }
    label { display: block; margin: 12px 0 4px; }
    input { width: 100%; padding: 8px; font-size: 14px; }
    button { margin-top: 16px; padding: 10px 16px; font-size: 15px; }
    .card { border: 1px solid #ccc; border-radius: 8px; padding: 24px; box-shadow: 0 4px 8px rgba(0,0,0,0.05); }
    #result { margin-top: 16px; font-weight: bold; color: #0b6; }
  </style>
</head>
<body>
  <h1>Loopert Agentic Browser POC</h1>
  <p>This local page is used to validate the automation loop. Fields below are default test data.</p>
  <div class="card">
    <label for="name">Full name</label>
    <input id="name" name="name" placeholder="Jane Doe" />

    <label for="email">Email</label>
    <input id="email" name="email" type="email" placeholder="jane@example.com" />

    <label for="password">Password</label>
    <input id="password" name="password" type="password" placeholder="" />

    <button id="submit" type="button">Submit</button>
    <div id="result"></div>
  </div>

  <script>
    const result = document.getElementById('result');
    document.getElementById('submit').addEventListener('click', () => {
      const name = document.getElementById('name').value || '(no name)';
      const email = document.getElementById('email').value || '(no email)';
      result.textContent = 'Submitted ' + name + ' / ' + email;
    });
  </script>
</body>
</html>`;
}

async function startTestServer(port = 3000) {
  const html = createTestPageHtml();
  const server = http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });

  const start = (desiredPort) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(desiredPort, () => {
        server.off('error', reject);
        resolve(server.address().port);
      });
    });

  let actualPort;
  try {
    actualPort = await start(port);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      actualPort = await start(0);
    } else {
      throw err;
    }
  }

  return {
    server,
    url: `http://localhost:${actualPort}`
  };
}

async function promptYesNo(rl, question) {
  const answer = (await rl.question(`${question} (y/n): `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function createKillSignal() {
  return { aborted: false };
}

function runBrowserUse(goal, model, ollamaUrl = 'http://localhost:11434', taskEnv = {}) {
  const llmBase = `${ollamaUrl.replace(/\/$/, '')}/v1`;
  const browserPath = process.env.BROWSER_USE_BROWSER_PATH;
  const userDataDir = process.env.BROWSER_USE_USER_DATA_DIR;
  const baseArgs = [
    'run',
    '--model',
    model || 'ollama/llama3',
    '--llm-base-url',
    llmBase,
    '--task',
    goal
  ];
  baseArgs.push('--browser', 'real');
  if (browserPath) {
    baseArgs.push('--browser-path', browserPath);
  }
  if (userDataDir) {
    baseArgs.push('--user-data-dir', userDataDir);
  }
  const env = { ...process.env, ...taskEnv };
  let res = spawnSync('browser-use', baseArgs, { stdio: 'inherit', env });
  if (res.status !== 0) {
    // retry via python -m browser_use.cli run ...
    const pyArgs = ['-m', 'browser_use.cli', ...baseArgs];
    res = spawnSync('python', pyArgs, { stdio: 'inherit', env });
  }
  if (res.status !== 0) {
    console.error(
      'browser-use missing or outdated. Install/upgrade with: pip install "browser-use[cli]" --upgrade (or npm run browser-use:local once)'
    );
  }
  return res.status === 0;
}

async function runDeterministicGoogleSearch(query, options) {
  const { headless, devtools, keepOpen } = options;
  const artifactsDir = 'artifacts';
  ensureDir(artifactsDir);
  const browser = await chromium.launch({ headless, devtools });
  const context = await browser.newContext();
  const page = await context.newPage();

  const snap = async (label) => {
    const file = `${artifactsDir}/google-${label}-${Date.now()}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log(`snapshot: ${file}`);
  };

  await page.goto('https://www.google.com/?hl=en', { waitUntil: 'domcontentloaded' });
  await snap('landing');

  const box = page.locator('textarea[name="q"], input[name="q"]').first();
  await box.fill(query, { timeout: 8000 });
  await box.press('Enter');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1200);
  await snap('results');

  const firstResult = page.locator('h3').first();
  await firstResult.click({ timeout: 8000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1200);
  await snap('opened-result');

  if (!keepOpen) {
    await browser.close();
  } else {
    console.log('Browser left open; close manually when done.');
  }
  return { status: 'ok', executor: 'deterministic-google' };
}

function cssEscape(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

async function resolveLocator(page, key) {
  const target = String(key || '').trim();
  if (!target) throw new Error('selector_missing_key');
  // If a raw CSS/XPath-like selector is provided, try it directly first
  if (/^([.#\[]|\/\/)/.test(target) || /[\s\[=:]/.test(target)) {
    try {
      const loc = page.locator(target);
      const handle = await loc.first().elementHandle({ timeout: 800 });
      if (handle) return loc.first();
    } catch (_) {
      // fall through to heuristic lookup
    }
  }
  const candidates = [
    page.locator(`#${cssEscape(target)}`),
    page.locator(`[name="${target}"]`),
    page.getByLabel(target),
    page.locator(`[placeholder="${target}"]`),
    page.getByText(target).first()
  ];
  for (const locator of candidates) {
    try {
      const handle = await locator.first().elementHandle({ timeout: 1000 });
      if (handle) return locator.first();
    } catch (_) {
      continue;
    }
  }
  throw new Error('selector_not_found');
}

async function guardPasswordField(locator) {
  const type = (await locator.getAttribute('type')) || '';
  if (type.toLowerCase() === 'password') {
    throw new Error('password_guard_blocked');
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function takeSnapshot(page, artifactsDir) {
  ensureDir(artifactsDir);
  const file = `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  const pathOut = `${artifactsDir}/${file}`;
  await page.screenshot({ path: pathOut, fullPage: true });
  return pathOut;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enforceRate(lastActionAt, minMs = 250) {
  const elapsed = Date.now() - lastActionAt.value;
  if (elapsed < minMs) await sleep(minMs - elapsed);
  lastActionAt.value = Date.now();
}

async function main() {
  const rl = readline.createInterface({ input, output });
  const killSignal = createKillSignal();

  process.on('SIGINT', () => {
    if (killSignal.aborted) {
      process.exit(1);
    }
    killSignal.aborted = true;
    console.log('\nKill switch triggered. Stopping after current action...');
  });

  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    process.exit(0);
  }
  const cliConfigPath = flags['cli-config'] || 'config.yaml';
  const fileConfig = loadCliConfig(cliConfigPath);
  const merged = {
    model: flags.model || fileConfig.model || DEFAULTS.model,
    host: flags.host || fileConfig.host || DEFAULTS.host,
    profile: flags.profile || fileConfig.profile || DEFAULTS.profile,
    Config: flags.config || fileConfig._config || DEFAULTS.Config,
    promptVariant: flags['prompt-variant'] || fileConfig.prompt_variant,
    workspace: flags.workspace || fileConfig.workspace || DEFAULTS.workspace,
    executor: flags.executor || fileConfig.executor || DEFAULTS.executor,
    keepOpen: Boolean(flags['keep-open'] || fileConfig.keep_open || DEFAULTS.keepOpen),
    fallbackPlaywright:
      flags['fallback-playwright'] !== undefined
        ? Boolean(flags['fallback-playwright'])
        : fileConfig.fallback_playwright ?? DEFAULTS.fallbackPlaywright,
    headless:
      flags.headless === true
        ? true
        : flags.headless === false
          ? false
          : fileConfig.headless ?? DEFAULTS.headless,
    devtools:
      flags.devtools === true
        ? true
        : flags.devtools === false
          ? false
          : fileConfig.devtools ?? DEFAULTS.devtools,
    autoApprove:
      flags.yes || flags.y
        ? true
        : fileConfig.auto_approve ?? DEFAULTS.autoApprove,
    planPath: flags.plan || fileConfig.plan,
    llmLog:
      flags['no-llm-log']
        ? 'off'
        : flags['verbose-llm']
          ? 'full'
          : fileConfig.llm_log || DEFAULTS.llmLog,
    repl: flags.repl ?? fileConfig.repl ?? DEFAULTS.repl,
    manualDefault: flags.manual ?? fileConfig.manual_default ?? DEFAULTS.manualDefault,
    disableTestSite: flags['disable-test-site'] ?? fileConfig.disable_test_site ?? DEFAULTS.disableTestSite,
    stubPlan: Boolean(flags['stub-plan'] || fileConfig.stub_plan)
  };
  const useStubPlan = Boolean(merged.stubPlan);
  const headless = Boolean(merged.headless);
  const devtools = Boolean(merged.devtools);
  const cookieDismiss = Boolean(merged.cookieDismiss);
  const autoApprove = Boolean(merged.autoApprove);
  const model = merged.model;
  const host = merged.host;
  const profile = merged.profile;
  const configPath = merged.Config;
  const promptVariant = merged.promptVariant;
  const workspace = merged.workspace;
  const executor = merged.executor;
  const keepOpen = merged.keepOpen;
  const fallbackPlaywright = merged.fallbackPlaywright;
  const planPath = merged.planPath;
  const llmLog = merged.llmLog;
  const replMode = Boolean(merged.repl);
  const manualMode = Boolean(merged.manualDefault) || (replMode && !goal && !planPath && !useStubPlan);
  const disableTestSite = Boolean(merged.disableTestSite);

  let server = null;
  let url = '';
  if (!disableTestSite) {
    const started = await startTestServer(3000);
    server = started.server;
    url = started.url;
    console.log(`Local test site ready at ${url}`);
    console.log('Password field typing should be blocked by policy.\n');
  } else {
    console.log('Test site disabled via config; bring your own target URL.');
  }
  const argGoal = positional.join(' ');
  let goal = argGoal;
  if (!goal || !goal.trim()) {
    goal = '';
  }

  const confirmPlan = async (plan) => {
    if (autoApprove) return true;
    if (rl.closed) return true;
    console.log('\nProposed plan:');
    plan.steps.forEach((step, idx) => {
      console.log(` ${idx + 1}. ${step.tool} ${JSON.stringify(step.args)}`);
    });
    return promptYesNo(rl, 'Approve plan?');
  };

  const confirmOriginChange = async (from, to) => {
    if (autoApprove) return true;
    if (rl.closed) return true;
    return promptYesNo(rl, `Origin change detected: ${from} -> ${to}. Proceed?`);
  };

  async function runOnce(goalText) {
    let precomputedPlan = null;
    if (planPath) {
      const raw = fs.readFileSync(planPath, 'utf8');
      precomputedPlan = JSON.parse(raw);
    }
    const effectiveGoal =
      goalText && goalText.trim()
        ? goalText
        : url
          ? `Navigate to ${url}, type "Jane Doe" into field with id "name", type "jane@example.com" into field with id "email", click the button with id "submit", wait_for_idle for 800ms, then snapshot.`
          : 'Please navigate to a target URL, interact as needed, then snapshot.';

    console.log('\nRunning POC. Press Ctrl+C to trigger kill switch.');
    if (executor === 'browser-use') {
      const ok = runBrowserUse(
        effectiveGoal,
        model || 'ollama/llama3',
        host || process.env.OLLAMA_HOST || 'http://localhost:11434'
      );
      console.log('\nResult:', ok ? { status: 'ok', executor: 'browser-use' } : { status: 'failed', executor: 'browser-use' });
      if (ok) return { status: 'ok', executor: 'browser-use' };
      if (!fallbackPlaywright) {
        return { status: 'failed', executor: 'browser-use' };
      }
      console.log('browser-use failed; falling back to Playwright executor.');
    }

    const result = await runPocSession({
      goal: effectiveGoal,
      model,
      host,
      profile,
      configPath,
      promptVariant,
      workspace,
      precomputedPlan: useStubPlan ? buildStubPlan(url) : precomputedPlan,
      confirmPlan,
      confirmOriginChange,
      onUpdate: (msg) => console.log(msg),
      killSignal,
      headless,
      devtools,
      cookieDismiss,
      llmLog
    });
    console.log('\nResult:', result);
    return result;
  }

  async function runToolRepl() {
    console.log('\nEntering tool REPL (manual commands). Type "help" for commands, blank to quit.');
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();
    let currentOrigin = null;
    const artifactsDir = 'artifacts';
    const lastActionAt = { value: 0 };

    const help = () => {
      console.log(`Commands:
  navigate <url>
  click <id|text|aria|placeholder>
  type <id> <text>
  scroll <deltaY>
  wait <ms>
  snapshot
  help
  exit`);
    };

    help();
    let line = await rl.question('cmd> ');
    while (line && line.trim()) {
      const [cmd, ...rest] = line.trim().split(' ');
      try {
        await enforceRate(lastActionAt, 250);
        if (killSignal.aborted) throw new Error('killed');
        switch (cmd) {
          case 'navigate': {
            const url = rest.join(' ');
            if (!url) throw new Error('navigate_missing_url');
            const nextOrigin = new URL(url).origin;
            if (currentOrigin && nextOrigin !== currentOrigin && !autoApprove) {
              const ok = await promptYesNo(rl, `Origin change ${currentOrigin} -> ${nextOrigin}. Proceed?`);
              if (!ok) throw new Error('origin_change_denied');
            }
            const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
            currentOrigin = new URL(page.url()).origin;
            console.log(`navigated (${res?.status() || 'no response'}) -> ${page.url()}`);
            break;
          }
          case 'click': {
            const key = rest.join(' ');
            if (!key) throw new Error('click_missing_id');
            const locator = await resolveLocator(page, key);
            await locator.click({ timeout: 8000 });
            console.log('click ok');
            break;
          }
          case 'type': {
            const key = rest.shift();
            const text = rest.join(' ');
            if (!key) throw new Error('type_missing_id');
            const locator = await resolveLocator(page, key);
            await guardPasswordField(locator);
            await locator.fill(text, { timeout: 8000 });
            console.log('type ok');
            break;
          }
          case 'scroll': {
            const deltaY = Number(rest[0] || 500);
            await page.mouse.wheel(0, deltaY);
            console.log('scroll ok');
            break;
          }
          case 'wait': {
            const ms = Number(rest[0] || 500);
            await page.waitForTimeout(ms);
            console.log(`waited ${ms} ms`);
            break;
          }
          case 'snapshot': {
            const file = await takeSnapshot(page, artifactsDir);
            console.log(`snapshot saved: ${file}`);
            break;
          }
          case 'help':
            help();
            break;
          default:
            console.log('Unknown command. Type "help".');
        }
      } catch (err) {
        if (err.message === 'password_guard_blocked') {
          console.log('Blocked: password field');
        } else if (err.message === 'killed') {
          console.log('Stopped by kill switch.');
          break;
        } else {
          console.log(`Error: ${err.message}`);
        }
      }
      line = await rl.question('cmd> ');
    }
    await browser.close();
  }

  if (replMode) {
    let firstGoal = goal;
    if (!firstGoal) {
      firstGoal = await rl.question('Enter goal (blank to quit, or type "manual" to enter tool REPL): ');
      if (firstGoal.trim().toLowerCase() === 'manual') {
        await runToolRepl();
        server.close();
        rl.close();
        process.exit(0);
      }
    }
    let current = firstGoal;
    while (current && current.trim()) {
      await runOnce(current);
      if (rl.closed || killSignal.aborted) break;
      current = await rl.question('\nEnter next goal (blank to quit): ');
    }
  } else {
    if (!goal.trim()) {
      goal = await rl.question(`Enter goal (leave empty to use default): `);
    }
    await runOnce(goal);
  }

  if (server) {
    server.close();
  }
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error', err);
  process.exit(1);
});
