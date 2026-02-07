import { spawnSync } from 'child_process';
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import readline from 'readline';

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.includes('=')
        ? a.slice(2).split('=')
        : [a.slice(2), argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true];
      flags[k] = v;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function loadConfig(p) {
  if (!fs.existsSync(p)) return {};
  try {
    return yaml.load(fs.readFileSync(p, 'utf8')) || {};
  } catch (e) {
    console.warn(`Could not read ${p}: ${e.message}`);
    return {};
  }
}

function printHelp() {
  console.log(`Loopert agent-browser runner
Usage: node apps/desktop/index.js "<goal>" [options]
Options:
  --model <name>       Ollama model for planning (default: qwen3-vl:4b)
  --vision-model <name> Vision model for captcha detection (default: qwen3-vl:4b)
  --host <url>         Ollama host (default: http://localhost:11434)
  --headed             Show browser window
  --supervised          Enable HITL prompts when blocked
  --hitl-auto           Auto-ack HITL prompts
  --plan-only           Only generate plan files; do not launch browser
  --dry-run             Snapshot-only execution; do not perform actions
  --full-page           Take full-page screenshots (default when goal mentions snapshot)
  --viewport <WxH>      Set browser viewport, e.g. 1920x1080
  --reset-daemon        Close agent-browser daemon before run
  --verbose             Verbose logging
  --vision-pointer      Allow vision-guided pointer actions when refs are missing
  --executable-path     Custom browser executable path
  --user-data-dir <path> Chrome user data directory
  --list-profiles        List local Chrome profiles and exit
  --profile <name>       Use a specific Chrome profile (name or directory)
  --cdp <port|url>      Connect to an existing Chrome via CDP
  --cdp-auto            If Chrome is running, try to attach via CDP on 9222
  --close-chrome        Close all Chrome processes before launching a profile
  --session <name>      Agent-browser session name
  --config <path>       CLI yaml (default: config.yaml)
  --help                Show this help
Example:
  npm run desktop -- "Open google.com search openai, click first result" --yes --headed
`);
}

const DEFAULTS = {
  model: 'qwen3-vl:4b',
  host: 'http://localhost:11434',
  configPath: 'config.yaml',
  headed: false,
  supervised: false,
  hitlAuto: false,
  planOnly: false,
  dryRun: false,
  fullPage: false,
  viewport: '1920x1080',
  resetDaemon: true,
  executablePath: 'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
  userDataDir: process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data') : '',
  profile: '',
  cdp: '',
  cdpAuto: false,
  closeChrome: false,
  visionModel: 'qwen3-vl:4b',
  verbose: false,
  visionPointer: false,
};

function logVerbose(verbose, msg, extra) {
  if (!verbose) return;
  if (extra !== undefined) console.log(`[verbose] ${msg}`, extra);
  else console.log(`[verbose] ${msg}`);
}

let VERBOSE = false;
let GLOBAL_CDP = '';

function makeBaseArgs(session, headed, executablePath, browserArgs, profilePath) {
  const args = [];
  if (GLOBAL_CDP) {
    args.push('--cdp', GLOBAL_CDP);
  } else {
    args.push('--session', session);
    if (headed) args.push('--headed');
    if (executablePath) args.push('--executable-path', executablePath);
    if (profilePath) args.push('--profile', profilePath);
    if (browserArgs) args.push('--args', browserArgs);
  }
  return args;
}

const POPUP_REJECT = [
  'reject', 'decline', 'deny', 'refuse', 'later', 'close', 'dismiss', 'not now', 'skip',
  'refuser', 'rejeter', 'refuse', 'non', 'plus tard', 'fermer',
  'ablehnen', 'verweigern', 'schließen', 'nein',
  'rechazar', 'denegar', 'cerrar', 'no',
  'rifiuta', 'nega', 'chiudi', 'no',
  'recusar', 'negar', 'fechar', 'nao',
  'weiger', 'sluit', 'nee',
  'avslå', 'lukk', 'nej',
  'hylkää', 'sulje', 'ei',
  'отклон', 'закры', 'нет',
  'отхвър', 'отказ', 'не прием',
  '拒否', '拒绝', '닫기', '거부'
];
const POPUP_ACCEPT = [
  'accept', 'agree', 'allow', 'consent', 'ok', 'continue',
  'accepter', 'autoriser', 'continuer',
  'akzeptieren', 'zustimmen',
  'aceptar', 'permitir', 'continuar',
  'accetta', 'consenti', 'continua',
  'aceitar', 'permitir', 'continuar',
  'accepteren', 'toestaan',
  'godta', 'tillad',
  'hyväksy',
  'принять', 'соглас',
  'прием', 'разреш', 'съглас',
  '同意', '接受', '허용'
];
const POPUP_HINTS = [
  'cookie', 'cookies', 'consent', 'privacy', 'personalization', 'preferences',
  'paramètres', 'parametres', 'confidentialité', 'confidentialite',
  'consentement', 'personalisation'
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeText(v) {
  return (v || '').toString().trim().toLowerCase();
}

function pickRefByKeywords(refs, keywords) {
  const entries = Object.entries(refs || {});
  for (const [ref, meta] of entries) {
    const name = normalizeText(meta?.name || meta?.text || '');
    if (!name) continue;
    const tokens = name.split(/[^a-z0-9\u00C0-\u017F]+/i).filter(Boolean);
    const match = keywords.some((k) => {
      if (k.length <= 3) return tokens.includes(k);
      return name.includes(k);
    });
    if (match) return ref;
  }
  return null;
}

function hasPopupHints(refs) {
  return Boolean(pickRefByKeywords(refs, POPUP_HINTS));
}

function pickSearchBoxRef(refs) {
  const entries = Object.entries(refs || {});
  const inputRoles = ['textbox', 'searchbox', 'combobox'];
  const isInputRole = (role) => inputRoles.some((r) => role.includes(r));
  for (const [ref, meta] of entries) {
    const role = normalizeText(meta?.role || '');
    if (isInputRole(role)) return ref;
  }
  for (const [ref, meta] of entries) {
    const role = normalizeText(meta?.role || '');
    if (role.includes('button') || role.includes('link')) continue;
    const name = normalizeText(meta?.name || meta?.text || '');
    if (!name) continue;
    if (
      name.includes('search') ||
      name.includes('recherche') ||
      name.includes('buscar') ||
      name.includes('cerca') ||
      name.includes('pesquisa') ||
      name.includes('поиск') ||
      name.includes('търс')
    ) {
      return ref;
    }
  }
  return null;
}

function pickSearchSubmitRef(refs) {
  const entries = Object.entries(refs || {});
  for (const [ref, meta] of entries) {
    const role = normalizeText(meta?.role || '');
    const name = normalizeText(meta?.name || meta?.text || '');
    if (role !== 'button') continue;
    if (
      name.includes('search') ||
      name.includes('recherche') ||
      name.includes('buscar') ||
      name.includes('търс')
    ) return ref;
  }
  return null;
}

function pickFirstResultLink(refs) {
  const entries = Object.entries(refs || {});
  for (const [ref, meta] of entries) {
    const role = normalizeText(meta?.role || '');
    const name = normalizeText(meta?.name || meta?.text || '');
    if (role !== 'link') continue;
    if (!name || name.length < 3) continue;
    if (
      name.includes('google') ||
      name.includes('gmail') ||
      name.includes('images') ||
      name.includes('maps') ||
      name.includes('videos') ||
      name.includes('shopping') ||
      name.includes('news')
    ) continue;
    return ref;
  }
  return null;
}

function resolveAgentBrowserBin() {
  if (process.env.AGENT_BROWSER_BIN) return process.env.AGENT_BROWSER_BIN;
  const candidates = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\\\Program Files (x86)';
    const globalBin = path.join(programFiles, 'nodejs', 'node_modules', 'agent-browser', 'bin');
    candidates.push(path.join(globalBin, 'agent-browser.js'));
    candidates.push(path.join(globalBin, 'agent-browser-win32-x64.exe'));
    candidates.push(path.join(appData, 'npm', 'agent-browser.cmd'));
    candidates.push(path.join(appData, 'npm', 'agent-browser'));
    candidates.push(path.join(programFiles, 'nodejs', 'agent-browser.cmd'));
    candidates.push(path.join(programFiles, 'nodejs', 'agent-browser'));
    candidates.push(path.join(programFilesX86, 'nodejs', 'agent-browser.cmd'));
    candidates.push(path.join(programFilesX86, 'nodejs', 'agent-browser'));
  } else {
    candidates.push('agent-browser');
    candidates.push('/usr/local/bin/agent-browser');
    candidates.push('/usr/bin/agent-browser');
  }
  for (const c of candidates) {
    if (!c || c === 'agent-browser') return c;
    if (fs.existsSync(c)) return c;
  }
  return 'agent-browser';
}

function runAgentBrowser(args, { json = false, timeoutMs = 30000, env = {}, retryOnDaemon = true, verbose = VERBOSE } = {}) {
  const finalArgs = [...args];
  if (json && !finalArgs.includes('--json')) finalArgs.push('--json');
  const bin = resolveAgentBrowserBin();
  const isJs = bin.toLowerCase().endsWith('.js');
  const needsShell = /\\.cmd$|\\.bat$/i.test(bin);
  logVerbose(verbose, `agent-browser: ${bin} ${finalArgs.join(' ')}`);
  let res;
  if (isJs) {
    res = spawnSync('node', [bin, ...finalArgs], {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, ...env },
    });
  } else if (needsShell) {
    const esc = (v) => `"${String(v).replace(/\"/g, '\\"')}"`;
    const cmd = [esc(bin), ...finalArgs.map(esc)].join(' ');
    res = spawnSync(cmd, {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, ...env },
      shell: true,
    });
  } else {
    res = spawnSync(bin, finalArgs, {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, ...env },
    });
  }
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT' && retryOnDaemon) {
      logVerbose(verbose, 'agent-browser timeout; resetting daemon and retrying');
      try {
        closeDaemonBestEffort();
        waitForDaemonShutdown();
        cleanupDaemonArtifacts();
      } catch {
        // ignore
      }
      const bumped = Math.min(timeoutMs * 2, 120000);
      return runAgentBrowser(args, { json, timeoutMs: bumped, env, retryOnDaemon: false, verbose });
    }
    throw res.error;
  }
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || '').trim();
    logVerbose(verbose, 'agent-browser error', msg);
    if (retryOnDaemon && msg.includes('daemon already running')) {
      try {
        closeDaemonBestEffort();
        waitForDaemonShutdown();
        cleanupDaemonArtifacts();
        return runAgentBrowser(args, { json, timeoutMs, env, retryOnDaemon: false, verbose });
      } catch {
        // fall through to error
      }
    }
    if (retryOnDaemon && msg.includes('Daemon failed to start')) {
      try {
        cleanupDaemonArtifacts();
        return runAgentBrowser(args, { json, timeoutMs, env, retryOnDaemon: false, verbose });
      } catch {
        // fall through to error
      }
    }
    throw new Error(`agent-browser failed: ${msg}`);
  }
  const out = (res.stdout || '').trim();
  logVerbose(verbose, 'agent-browser stdout', out);
  if (!json) return out;
  try {
    return JSON.parse(out);
  } catch (e) {
    const m = out.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error(`Failed to parse JSON output: ${out}`);
  }
}

function closeDaemonBestEffort() {
  try {
    runAgentBrowser(['close'], { timeoutMs: 15000, retryOnDaemon: false, verbose: VERBOSE });
  } catch {
    // ignore
  }
}

function waitForDaemonShutdown() {
  // give the daemon time to release sockets/processes
  try {
    spawnSync('cmd.exe', ['/d', '/s', '/c', 'timeout /t 2 >nul'], { timeout: 3000 });
  } catch {
    // ignore
  }
}

function cleanupDaemonArtifacts() {
  try {
    const base = path.join(process.env.USERPROFILE || 'C:\\\\Users\\\\ROG', '.agent-browser');
    if (!fs.existsSync(base)) return;
    const files = fs.readdirSync(base);
    const pidFiles = files.filter((f) => f.endsWith('.pid'));
    for (const f of pidFiles) {
      try {
        const pid = fs.readFileSync(path.join(base, f), 'utf8').trim();
        if (pid) {
          spawnSync('taskkill', ['/PID', pid, '/F'], { timeout: 5000 });
        }
      } catch {
        // ignore
      }
    }
    const junk = files.filter((f) => f.endsWith('.sock') || f.endsWith('.pid') || f.endsWith('.port'));
    for (const f of junk) {
      try {
        fs.unlinkSync(path.join(base, f));
      } catch {
        // ignore per-file
      }
    }
    if (process.platform === 'win32') {
      try {
        const res = spawnSync('wmic', ['process', 'where', 'name="node.exe"', 'get', 'ProcessId,CommandLine'], {
          encoding: 'utf8',
          timeout: 3000,
        });
        const lines = (res.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (!line.toLowerCase().includes('agent-browser')) continue;
          const pidMatch = line.match(/(\d+)\s*$/);
          if (pidMatch) {
            spawnSync('taskkill', ['/PID', pidMatch[1], '/F'], { timeout: 5000 });
          }
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function getChromeProfiles(userDataDir) {
  if (!userDataDir || !fs.existsSync(userDataDir)) return [];
  const profiles = [];
  const localStatePath = path.join(userDataDir, 'Local State');
  try {
    if (fs.existsSync(localStatePath)) {
      const data = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
      const cache = data?.profile?.info_cache || {};
      for (const [dir, meta] of Object.entries(cache)) {
        profiles.push({ dir, name: meta?.name || dir });
      }
    }
  } catch {
    // ignore parse errors, fallback to dir scan
  }
  if (profiles.length) return profiles;
  try {
    const entries = fs.readdirSync(userDataDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'Default' || /^Profile\s+\d+$/i.test(e.name)) {
        profiles.push({ dir: e.name, name: e.name });
      }
    }
  } catch {
    // ignore
  }
  return profiles;
}

function isProfileLocked(profileRoot) {
  if (!profileRoot) return false;
  try {
    return fs.existsSync(path.join(profileRoot, 'SingletonLock'));
  } catch {
    return false;
  }
}

function isChromeRunning() {
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe'], { encoding: 'utf8', timeout: 3000 });
      return (res.stdout || '').toLowerCase().includes('chrome.exe');
    }
    const res = spawnSync('ps', ['-A'], { encoding: 'utf8', timeout: 3000 });
    return (res.stdout || '').toLowerCase().includes('chrome');
  } catch {
    return false;
  }
}

function closeChromeBestEffort(verbose) {
  try {
    if (process.platform === 'win32') {
      logVerbose(verbose, 'closing Chrome (taskkill)');
      spawnSync('taskkill', ['/IM', 'chrome.exe', '/F'], { timeout: 8000 });
    } else {
      logVerbose(verbose, 'closing Chrome (pkill)');
      spawnSync('pkill', ['-f', 'chrome'], { timeout: 8000 });
    }
  } catch {
    // ignore
  }
}

async function isCdpReachable(target) {
  if (!target) return false;
  let url;
  try {
    if (/^https?:\/\//i.test(target)) url = target;
    else if (/^\d+$/.test(String(target))) url = `http://127.0.0.1:${target}`;
    else url = `http://${target}`;
    if (!url.endsWith('/json/version')) url = `${url.replace(/\/$/, '')}/json/version`;
  } catch {
    return false;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function pickProfileInteractively(profiles) {
  if (!profiles.length) return '';
  console.log('Available Chrome profiles:');
  profiles.forEach((p, i) => {
    console.log(`  [${i + 1}] ${p.name} (${p.dir})`);
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question('Select profile number (or blank to skip): ', resolve));
  rl.close();
  const idx = Number(String(answer).trim());
  if (!Number.isFinite(idx) || idx < 1 || idx > profiles.length) return '';
  return profiles[idx - 1].dir;
}

async function askHuman(prompt, hitlAuto) {
  if (hitlAuto) return '[auto-ack HITL]';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${prompt}\n> `, resolve));
  rl.close();
  return answer;
}

function waitForLoad(session, headed, executablePath, browserArgs, profilePath) {
  const args = makeBaseArgs(session, headed, executablePath, browserArgs, profilePath);
  args.push('wait', '1200');
  try {
    runAgentBrowser(args, { timeoutMs: 15000 });
  } catch {
    try {
      runAgentBrowser([...makeBaseArgs(session, headed, executablePath, browserArgs, profilePath), 'wait', '1200']);
    } catch {
      // best-effort
    }
  }
}

async function callVisionLLM(imagePath, model, host, prompt) {
  try {
    logVerbose(VERBOSE, 'calling vision model');
    if (!fs.existsSync(imagePath)) return null;
    const imageB64 = fs.readFileSync(imagePath).toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 150000);
    const res = await fetch(`${host.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}` } },
            ],
          },
        ],
        stream: false,
      }),
    });
    clearTimeout(timeout);
    if (!res.ok) {
      logVerbose(VERBOSE, 'vision http error', res.status);
      return null;
    }
    const data = await res.json();
    logVerbose(VERBOSE, 'vision raw response', data);
    const content = data?.choices?.[0]?.message?.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}


async function visionClassifyBlocker(imagePath, model, host) {
  const prompt = [
    'Classify this screenshot. Reply ONLY JSON:',
    '{"type":"captcha|cookie|overlay","reason":"...","suggested_labels":["..."]}.',
    'Rules: do NOT solve captchas. If a captcha or verification is visible, set type="captcha".',
  ].join(' ');
  return callVisionLLM(imagePath, model, host, prompt);
}

async function visionSuggestAction(snapshotText, imagePath, model, host, goal, purpose = 'general') {
  const safeGoal = goal ? String(goal).slice(0, 500) : '';
  const prompt = [
    'You are assisting a deterministic browser automation tool.',
    'Given the snapshot list and screenshot, suggest actions that can be executed by matching element labels to snapshot refs.',
    'Return ONLY JSON: {"action":"click|fill","labels":["..."],"role_hint":"button|link|combobox|textbox|menuitem","input_text":"","reason":""}.',
    'Rules: do NOT solve captchas or verification. If captcha/verification is visible, return action="none" and explain.',
    purpose === 'blocker' ? 'Purpose: close a blocking popup/consent dialog. Prefer accept.' : 'Purpose: general navigation.',
    safeGoal ? `Goal: ${safeGoal}` : '',
    snapshotText ? `Snapshot:\n${snapshotText}` : '',
  ].filter(Boolean).join('\n');
  return callVisionLLM(imagePath, model, host, prompt);
}

async function visionSuggestPointerAction(imagePath, model, host) {
  const prompt = [
    'There may be multiple clicks needed; if more clicks are needed, return the next click coordinates.',
    'If a captcha/verification is visible, return action="none" and reason="captcha".',
    'Coordinates must be within the screenshot pixel space.',
    'You are assisting a deterministic browser automation tool.',
    'Rules: NEVER attempt to solve captcha/verification or click captcha widgets.',
    `Return ONLY JSON with this shape:
    {"action":"click|scroll|none","x":0,"y":0,"button":"left","scroll_dy":0,"reason":"...","confidence":0-1,"delay":500}`,

  ].join('\n');
  return callVisionLLM(imagePath, model, host, prompt);
}

function pickRefByLabels(refs, labels, roleHint) {
  if (!labels?.length) return null;
  const entries = Object.entries(refs || {});
  const normalizedLabels = labels.map((l) => normalizeText(l)).filter(Boolean);
  for (const [ref, meta] of entries) {
    const role = normalizeText(meta?.role || '');
    const name = normalizeText(meta?.name || meta?.text || '');
    if (!name) continue;
    if (roleHint && roleHint !== 'none' && role && !role.includes(roleHint)) continue;
    if (normalizedLabels.some((lbl) => name.includes(lbl))) return ref;
  }
  return null;
}

function isLikelyCaptchaSnapshot(snap) {
  const text = normalizeText(snap?.snapshot || '');
  if (!text) return false;
  if (text.includes('why did this happen?')) return true;
  if (text.includes('unusual traffic')) return true;
  if (text.includes('are you a robot')) return true;
  return false;
}

async function generatePlan(goal, model, host) {
  const schema = [
    'Return ONLY valid JSON with this schema:',
    '{',
    '  "plan_id": "string",',
    '  "goal": "string",',
    '  "steps": [',
    '    {',
    '      "id": 1,',
    '      "title": "string",',
    '      "intent": "open_url|search|click_first_result|click|wait|verify",',
    '      "params": { "url?": "string", "query?": "string", "target?": "string", "wait_ms?": 1000 },',
    '      "success_criteria": "string",',
    '      "fallback": "string"',
    '    }',
    '  ]',
    '}',
    'Rules:',
    '- steps must be in correct order and actionable.',
    '- open_url requires params.url.',
    '- search requires params.query.',
    '- click requires params.target.',
    '- click_first_result requires no params.',
    '- wait requires params.wait_ms.',
    '- verify should be the last step.',
  ].join('\n');

  const buildFallback = () => ([
    {
      id: 1,
      title: 'Open target page',
      intent: 'open_url',
      url: extractUrl(goal) || (goal.toLowerCase().includes('google') ? 'https://www.google.com' : ''),
      success_criteria: 'Page opened successfully',
      fallback: 'Retry once',
    },
    {
      id: 2,
      title: 'Search query',
      intent: 'search',
      query: extractQuery(goal),
      success_criteria: 'Results page visible',
      fallback: 'Use search box and press Enter',
    },
    {
      id: 3,
      title: 'Click first result',
      intent: 'click_first_result',
      success_criteria: 'Result page opened',
      fallback: 'Pick first visible result link',
    },
    {
      id: 4,
      title: 'Snapshot / verify',
      intent: 'verify',
      success_criteria: 'Goal satisfied',
      fallback: 'Report status',
    },
  ]);

  const validatePlan = (plan) => {
    if (!plan || typeof plan !== 'object') return { ok: false, error: 'plan_not_object' };
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) return { ok: false, error: 'steps_missing' };
    const allowed = new Set(['open_url', 'search', 'click_first_result', 'click', 'wait', 'verify']);
    for (let i = 0; i < plan.steps.length; i += 1) {
      const s = plan.steps[i];
      if (!s || typeof s !== 'object') return { ok: false, error: `step_${i + 1}_invalid` };
      if (!Number.isFinite(s.id)) s.id = i + 1;
      if (!s.title || !s.intent) return { ok: false, error: `step_${s.id}_missing_fields` };
      if (!allowed.has(s.intent)) return { ok: false, error: `step_${s.id}_bad_intent` };
      const p = s.params || {};
      if (s.intent === 'open_url' && !p.url) return { ok: false, error: `step_${s.id}_missing_url` };
      if (s.intent === 'search' && !p.query) return { ok: false, error: `step_${s.id}_missing_query` };
      if (s.intent === 'click' && !p.target) return { ok: false, error: `step_${s.id}_missing_target` };
      if (s.intent === 'wait' && !Number.isFinite(p.wait_ms)) return { ok: false, error: `step_${s.id}_missing_wait_ms` };
    }
    const last = plan.steps[plan.steps.length - 1];
    if (last.intent !== 'verify') return { ok: false, error: 'last_step_not_verify' };
    return { ok: true };
  };

  const normalizeSteps = (plan) => plan.steps.map((s) => ({
    id: s.id,
    title: s.title,
    intent: s.intent,
    url: s.params?.url || '',
    query: s.params?.query || '',
    target: s.params?.target || '',
    success_criteria: s.success_criteria || '',
    fallback: s.fallback || '',
  }));

  const requestPlan = async (systemPrompt) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${host.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }],
        stream: false,
      }),
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  };

  try {
    const plan = await requestPlan(`${schema}\nGoal: ${goal}`);
    const check = validatePlan(plan);
    if (check.ok) return normalizeSteps(plan);

    const repairPrompt = `${schema}\nGoal: ${goal}\nYour previous output was invalid: ${check.error}. Return a corrected JSON plan only.`;
    const repaired = await requestPlan(repairPrompt);
    const repairedCheck = validatePlan(repaired);
    if (repairedCheck.ok) return normalizeSteps(repaired);
  } catch {
    // fall through to fallback
  }

  return buildFallback();
}

function extractUrl(goal) {
  const m = goal.match(/https?:\/\/\S+/i);
  if (!m) return '';
  return m[0].replace(/[)\],;]+$/, '');
}

function extractQuery(goal) {
  const m = goal.match(/search\s+([^,\.]+)/i);
  if (!m) return 'openai';
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

function appendReport(runDir, obj) {
  try {
    fs.appendFileSync(path.join(runDir, 'report.jsonl'), `${JSON.stringify(obj)}\n`);
  } catch {
    // ignore
  }
}

function safeGet(cmdArgs, fallback = '') {
  try {
    return runAgentBrowser(cmdArgs, { timeoutMs: 10000 });
  } catch {
    return fallback;
  }
}

function getPageInfo(session, headed, executablePath, browserArgs, profilePath) {
  const args = makeBaseArgs(session, headed, executablePath, browserArgs, profilePath);
  const url = safeGet([...args, 'get', 'url']).trim();
  const title = safeGet([...args, 'get', 'title']).trim();
  return { url, title };
}

function isCaptchaUrl(url) {
  const u = (url || '').toLowerCase();
  return u.includes('/sorry/') || u.includes('recaptcha') || u.includes('captcha');
}

function isSearchResults(info) {
  const url = (info?.url || '').toLowerCase();
  if (!url) return false;
  if (isCaptchaUrl(url)) return false;
  return url.includes('/search?') || url.includes('q=');
}

function isGoogleDomain(url) {
  const u = (url || '').toLowerCase();
  return u.includes('google.') || u.includes('gstatic.') || u.includes('googleusercontent.') || u.includes('workspace.google.com');
}

function isNonGoogle(url) {
  const u = (url || '').toLowerCase();
  if (!u) return false;
  return !isGoogleDomain(u) && !u.includes('about:');
}

function isGoogleSearchHost(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'www.google.com' || u.hostname === 'google.com';
  } catch {
    return false;
  }
}

function evaluateStep(step, startInfo, endInfo, snap) {
  const intent = step.intent;
  if (intent === 'open_url') {
    if (step.url) return (endInfo.url || '').includes(step.url.replace(/\/+$/, ''));
    return Boolean(endInfo.url && endInfo.url !== 'about:blank');
  }
  if (intent === 'search') {
    return isSearchResults(endInfo);
  }
  if (intent === 'click_first_result') {
    return isNonGoogle(endInfo.url);
  }
  if (intent === 'verify') return true;
  return Boolean(endInfo.url && endInfo.url !== startInfo.url);
}

function planToMarkdown(steps) {
  let md = '# Task Plan\n';
  for (const step of steps) {
    md += `\n- [ ] Step ${step.id}: ${step.title}\n`;
    md += `  - Intent: ${step.intent}\n`;
    if (step.url) md += `  - URL: ${step.url}\n`;
    if (step.query) md += `  - Query: ${step.query}\n`;
    if (step.target) md += `  - Target: ${step.target}\n`;
    if (step.success_criteria) md += `  - Success: ${step.success_criteria}\n`;
    if (step.fallback) md += `  - Fallback: ${step.fallback}\n`;
  }
  return md;
}

async function snapshot(session, headed, executablePath, runDir, label, browserArgs, profilePath) {
  const args = makeBaseArgs(session, headed, executablePath, browserArgs, profilePath);
  args.push('snapshot', '-i', '-c', '--json');
  const data = runAgentBrowser(args, { json: true, timeoutMs: 120000 });
  fs.writeFileSync(path.join(runDir, `${label}-snapshot.json`), JSON.stringify(data, null, 2));
  return data?.data || {};
}

async function safeSnapshot(session, headed, executablePath, runDir, label, browserArgs, profilePath) {
  try {
    return await snapshot(session, headed, executablePath, runDir, label, browserArgs, profilePath);
  } catch {
    return { refs: {} };
  }
}

async function handleCaptchaWithVision(session, headed, executablePath, runDir, stepId, browserArgs, profilePath, ctx) {
  const args = makeBaseArgs(session, headed, executablePath, browserArgs, profilePath);
  const shotPath = path.join(runDir, `step-${stepId}-blocker-vision.png`);
  try {
    const shotArgs = [...args, 'screenshot', shotPath];
    if (ctx?.fullPage) shotArgs.splice(shotArgs.length - 1, 0, '--full');
    runAgentBrowser(shotArgs, { timeoutMs: 20000, retryOnDaemon: false, verbose: ctx?.verbose });
  } catch {
    // ignore
  }
  const visionModel = ctx?.visionModel || ctx?.model;
  const visionHost = ctx?.host;
  if (visionModel && visionHost) {
    const verdict = await detectCaptchaViaVision(shotPath, visionModel, visionHost);
    if (verdict?.captcha) {
      if (ctx) ctx.lastBlockerMeta = { action: 'vision-captcha', reason: verdict.reason || 'captcha' };
      logVerbose(ctx?.verbose, 'vision captcha detected', verdict);
      return { captcha: true };
    }
  }
  return { captcha: false };
}

function runPointerAction(session, headed, executablePath, browserArgs, profilePath, ctx, action) {
  if (!action || action.action === 'none') return false;
  const baseArgs = makeBaseArgs(session, headed, executablePath, browserArgs, profilePath);
  if (action.action === 'scroll') {
    const dy = Number(action.scroll_dy || 0);
    runAgentBrowser([...baseArgs, 'mouse', 'wheel', `${dy}`], { verbose: ctx?.verbose });
    return true;
  }
  if (action.action === 'click') {
    const x = Math.max(0, Number(action.x || 0));
    const y = Math.max(0, Number(action.y || 0));
    const button = action.button || 'left';
    runAgentBrowser([...baseArgs, 'mouse', 'move', `${x}`, `${y}`], { verbose: ctx?.verbose });
    runAgentBrowser([...baseArgs, 'mouse', 'down', button], { verbose: ctx?.verbose });
    runAgentBrowser([...baseArgs, 'mouse', 'up', button], { verbose: ctx?.verbose });
    return true;
  }
  return false;
}

async function ensureSearchResults(ctx, query) {
  const { session, headed, executablePath, runDir, browserArgs, profilePath } = ctx;
  let info = getPageInfo(session, headed, executablePath, browserArgs, profilePath);
  if (isSearchResults(info)) return true;
  // If we drifted off the Google search host, force a direct search URL.
  if (!isGoogleSearchHost(info.url)) {
    try {
      const baseArgs = makeBaseArgs(session, headed, executablePath, browserArgs, profilePath);
      runAgentBrowser([...baseArgs, 'open', `https://www.google.com/search?q=${encodeURIComponent(query)}`]);
      waitForLoad(session, headed, executablePath, browserArgs, profilePath);
    } catch {
      // best-effort
    }
    info = getPageInfo(session, headed, executablePath, browserArgs, profilePath);
    return isSearchResults(info);
  }
  const snap = await safeSnapshot(session, headed, executablePath, runDir, 'ensure-search', browserArgs, profilePath);
  const ref = pickSearchBoxRef(snap.refs || {});
  const baseArgs = makeBaseArgs(session, headed, executablePath, browserArgs, profilePath);
  try {
    if (ref) {
      runAgentBrowser([...baseArgs, 'fill', `@${ref}`, query]);
    } else {
      runAgentBrowser([...baseArgs, 'find', 'role', 'combobox', 'fill', query]);
    }
    runAgentBrowser([...baseArgs, 'press', 'Enter']);
    waitForLoad(session, headed, executablePath, browserArgs, profilePath);
  } catch {
    // best-effort
  }
  info = getPageInfo(session, headed, executablePath, browserArgs, profilePath);
  return isSearchResults(info);
}

async function handleBlockers(session, headed, executablePath, runDir, stepId, supervised, hitlAuto, dryRun, browserArgs, ctx) {
  const profilePath = ctx?.profilePath;
  const pageInfo = getPageInfo(session, headed, executablePath, browserArgs, profilePath);
  if (isCaptchaUrl(pageInfo.url)) {
    if (supervised && !hitlAuto) {
      await askHuman('[HITL] CAPTCHA/verification detected. Please solve it, then press Enter to continue.', hitlAuto);
      return { handled: true, cleared: false, captcha: true };
    }
    return { handled: false, cleared: false, captcha: true };
  }
  let snap = await snapshot(session, headed, executablePath, runDir, `step-${stepId}-blocker`, browserArgs, profilePath);
  if (isLikelyCaptchaSnapshot(snap)) {
    if (supervised && !hitlAuto) {
      await askHuman('[HITL] CAPTCHA/verification detected. Please solve it, then press Enter to continue.', hitlAuto);
      return { handled: true, cleared: false, captcha: true };
    }
    return { handled: false, cleared: false, captcha: true };
  }
  let refs = snap.refs || {};
  let ref = pickRefByKeywords(refs, POPUP_REJECT) || pickRefByKeywords(refs, POPUP_ACCEPT);

  if (!ref) {
    await sleep(500);
    const late = await snapshot(session, headed, executablePath, runDir, `step-${stepId}-blocker-late`, browserArgs, profilePath);
    refs = late.refs || {};
    ref = pickRefByKeywords(refs, POPUP_REJECT) || pickRefByKeywords(refs, POPUP_ACCEPT);
  }

  if (!ref) {
    const refCount = Object.keys(refs || {}).length;
    if (refCount <= 1) {
      const args = makeBaseArgs(session, headed, executablePath, browserArgs, profilePath);
      const shotPath = path.join(runDir, `step-${stepId}-blocker-vision.png`);
      try {
        const shotArgs = [...args, 'screenshot', shotPath];
        if (ctx?.fullPage) shotArgs.splice(shotArgs.length - 1, 0, '--full');
        runAgentBrowser(shotArgs, { timeoutMs: 20000, retryOnDaemon: false, verbose: ctx?.verbose });
      } catch {
        // ignore
      }
      const visionModel = ctx?.visionModel || ctx?.model;
      const visionHost = ctx?.host;
      if (visionModel && visionHost) {

        let suggestion = await visionSuggestPointerAction(shotPath, visionModel, visionHost);
        logVerbose(ctx?.verbose, 'vision pointer suggestion', suggestion);
        let actedAny = false;
        while (true) {
          const actions = Array.isArray(suggestion?.actions) ? suggestion.actions : [suggestion];
          const actionable = actions.filter((a) => a?.action && a.action !== 'none');
          if (!actionable.length) break;
          if (dryRun) return { handled: true, cleared: true };
          let acted = false;
          for (let idx = 0; idx < actionable.length; idx += 1) {
            const act = actionable[idx];
                const did = runPointerAction(session, headed, executablePath, browserArgs, profilePath, ctx, act);
            if (did) {
              actedAny = true;
              acted = true;
              if (ctx) ctx.lastBlockerMeta = { action: 'vision-pointer', detail: act, attempt: idx + 1, total: actionable.length };
              let delayMs = Number(act?.delay_ms ?? act?.delayMs);
              if (!Number.isFinite(delayMs)) delayMs = 300 + Math.floor(Math.random() * 401);
              else delayMs = Math.max(300, Math.min(700, delayMs));
              await sleep(delayMs);
            }
          }
          if (acted) {
            try {
              const shotArgs = [...args, 'screenshot', shotPath];
              if (ctx?.fullPage) shotArgs.splice(shotArgs.length - 1, 0, '--full');
              runAgentBrowser(shotArgs, { timeoutMs: 20000, retryOnDaemon: false, verbose: ctx?.verbose });
            } catch {
              // ignore
            }
            suggestion = await visionSuggestPointerAction(shotPath, visionModel, visionHost, 'blocker');
            logVerbose(ctx?.verbose, 'vision pointer suggestion', suggestion);
            continue;
          }
          break;
        }
        if (actedAny) {
          return { handled: true, cleared: true };
        }
        return { handled: false, cleared: false };
      }
    }
  }

  if (!ref && ctx?.visionPointer) {
      const args = makeBaseArgs(session, headed, executablePath, browserArgs, profilePath);
    const shotPath = path.join(runDir, `step-${stepId}-pointer.png`);
    try {
      runAgentBrowser([...args, 'screenshot', shotPath], { timeoutMs: 20000, retryOnDaemon: false, verbose: ctx?.verbose });
      const suggestion = await visionSuggestPointerAction(shotPath, ctx?.visionModel || ctx?.model, ctx?.host, 'blocker');
      logVerbose(ctx?.verbose, 'vision pointer suggestion', suggestion);
      if (suggestion?.action && suggestion.action !== 'none' && !dryRun) {
        runPointerAction(session, headed, executablePath, browserArgs, profilePath, ctx, suggestion);
        if (ctx) ctx.lastBlockerMeta = { action: 'vision-pointer', detail: suggestion };
        await sleep(600);
        return { handled: true, cleared: true };
      }
    } catch {
      // ignore
    }
  }

  if (ref) {
    if (dryRun) return { handled: true, cleared: true };
    const args = makeBaseArgs(session, headed, executablePath, browserArgs, profilePath);
    args.push('click', `@${ref}`);
    try {
      runAgentBrowser(args, { verbose: ctx?.verbose });
      if (ctx) ctx.lastBlockerMeta = { action: 'blocker-click', ref };
    } catch {
      const retry = await snapshot(session, headed, executablePath, runDir, `step-${stepId}-blocker-retry`, browserArgs, profilePath);
      const retryRef = pickRefByKeywords(retry.refs || {}, POPUP_REJECT) || pickRefByKeywords(retry.refs || {}, POPUP_ACCEPT);
      if (retryRef) {
        runAgentBrowser([...args.slice(0, -1), `@${retryRef}`], { verbose: ctx?.verbose });
        if (ctx) ctx.lastBlockerMeta = { action: 'blocker-click', ref: retryRef, retry: true };
      }
    }
    await sleep(800);
    const after = await snapshot(session, headed, executablePath, runDir, `step-${stepId}-blocker-after`, browserArgs, profilePath);
    const still = pickRefByKeywords(after.refs || {}, POPUP_REJECT) || pickRefByKeywords(after.refs || {}, POPUP_ACCEPT) || hasPopupHints(after.refs || {});
    return { handled: true, cleared: !still };
  }

  if (hasPopupHints(refs)) {
    if (supervised) {
      await askHuman('[HITL] Clear blockers if any, then press Enter', hitlAuto);
      return { handled: true, cleared: false };
    }
    return { handled: false, cleared: false };
  }

  return { handled: false, cleared: true };
}

async function executeStep(step, ctx) {
  let { session, headed, executablePath, runDir, wantSnapshots, dryRun, supervised, hitlAuto, fullPage, browserArgs, profilePath } = ctx;
  ctx.lastActionMeta = null;
  const baseArgs = makeBaseArgs(session, headed, executablePath, browserArgs, profilePath);

  if (step.intent === 'open_url') {
    const url = step.url || extractUrl(ctx.goal) || 'https://www.google.com';
    if (!dryRun) {
      let opened = false;
      let attempt = 0;
      while (!opened && attempt < 2) {
        attempt += 1;
        try {
          runAgentBrowser([...baseArgs, 'open', url]);
          ctx.lastActionMeta = { action: 'open', url, attempt };
          waitForLoad(session, headed, executablePath, browserArgs, profilePath);
          const info = getPageInfo(session, headed, executablePath, browserArgs, profilePath);
          if (info.url && !info.url.startsWith('chrome-error://')) {
            opened = true;
            break;
          }
          throw new Error('chrome-error');
        } catch (e) {
          const msg = String(e?.message || e);
          if (executablePath && (msg.includes('ETIMEDOUT') || msg.includes('chrome-error'))) {
            console.warn('[runner] open failed; retrying without executable path');
            closeDaemonBestEffort();
            waitForDaemonShutdown();
            executablePath = null;
            ctx.executablePath = null;
            const retryArgs = makeBaseArgs(session, headed, executablePath, browserArgs, profilePath);
            try {
              runAgentBrowser([...retryArgs, 'open', url]);
              ctx.lastActionMeta = { action: 'open', url, attempt, fallback: 'no-executable-path' };
              waitForLoad(session, headed, executablePath, browserArgs, profilePath);
              const info = getPageInfo(session, headed, executablePath, browserArgs, profilePath);
              if (info.url && !info.url.startsWith('chrome-error://')) {
                opened = true;
                break;
              }
            } catch (err) {
              if (attempt >= 2) throw err;
            }
          } else {
            if (attempt >= 2) throw e;
          }
        }
      }
    }
  } else if (step.intent === 'search') {
    const startInfo = getPageInfo(session, headed, executablePath, browserArgs, profilePath);
    if (isSearchResults(startInfo)) {
      return;
    }
    if (!isGoogleSearchHost(startInfo.url)) {
      try {
        runAgentBrowser([...baseArgs, 'open', 'https://www.google.com']);
        waitForLoad(session, headed, executablePath, browserArgs, profilePath);
      } catch {
        // best-effort
      }
    }
    let snap = await safeSnapshot(session, headed, executablePath, runDir, `step-${step.id}-presearch`, browserArgs, profilePath);
    let ref = pickSearchBoxRef(snap.refs || {});
    if (!ref) {
      waitForLoad(session, headed, executablePath, browserArgs, profilePath);
      snap = await safeSnapshot(session, headed, executablePath, runDir, `step-${step.id}-presearch-retry`, browserArgs, profilePath);
      ref = pickSearchBoxRef(snap.refs || {});
    }
    const query = String(step.query || extractQuery(ctx.goal) || 'openai').trim() || 'openai';
    if (!dryRun) {
      const tryFill = async (useRef) => {
        if (useRef) {
          try {
            runAgentBrowser([...baseArgs, 'click', `@${useRef}`]);
            runAgentBrowser([...baseArgs, 'fill', `@${useRef}`, query]);
            ctx.lastActionMeta = { action: 'fill', ref: useRef, query };
            return true;
          } catch {
            return false;
          }
        }
        return false;
      };

      let filled = await tryFill(ref);
      if (!filled) {
        await handleBlockers(session, headed, executablePath, runDir, `${step.id}-inline`, supervised, hitlAuto, dryRun, browserArgs, ctx);
        const retrySnap = await safeSnapshot(session, headed, executablePath, runDir, `step-${step.id}-presearch-refill`, browserArgs, profilePath);
        filled = await tryFill(pickSearchBoxRef(retrySnap.refs || {}));
      }
      if (!filled) {
        if (supervised) {
          // Attempt direct search URL before escalating to human.
          try {
            runAgentBrowser([...baseArgs, 'open', `https://www.google.com/search?q=${encodeURIComponent(query)}`]);
            waitForLoad(session, headed, executablePath, browserArgs, profilePath);
            ctx.lastActionMeta = { action: 'open', url: `https://www.google.com/search?q=${encodeURIComponent(query)}`, fallback: 'direct-search-url' };
            return;
          } catch {
            // ignore
          }
          await askHuman('[HITL] Unable to fill search box. Please perform the search and press Enter.', hitlAuto);
        } else {
          try {
            runAgentBrowser([...baseArgs, 'open', `https://www.google.com/search?q=${encodeURIComponent(query)}`]);
            waitForLoad(session, headed, executablePath, browserArgs, profilePath);
            ctx.lastActionMeta = { action: 'open', url: `https://www.google.com/search?q=${encodeURIComponent(query)}`, fallback: 'direct-search-url' };
            return;
          } catch {
            throw new Error('Search box not found in snapshot');
          }
        }
      } else {
        await sleep(300);
        try {
          runAgentBrowser([...baseArgs, 'press', 'Enter']);
          ctx.lastActionMeta = { ...(ctx.lastActionMeta || {}), submit: 'press:Enter' };
        } catch {
          // ignore
        }
        waitForLoad(session, headed, executablePath, browserArgs, profilePath);
        // Ensure we actually landed on results
        if (!isSearchResults(getPageInfo(session, headed, executablePath, browserArgs, profilePath))) {
          const ensured = await ensureSearchResults(ctx, query);
          if (!ensured) {
            try {
              runAgentBrowser([...baseArgs, 'open', `https://www.google.com/search?q=${encodeURIComponent(query)}`]);
              waitForLoad(session, headed, executablePath, browserArgs, profilePath);
              ctx.lastActionMeta = { ...(ctx.lastActionMeta || {}), fallback: 'open-search-url' };
            } catch {
              // best-effort
            }
          }
        }
      }
    }
  } else if (step.intent === 'click_first_result') {
    let snap = await snapshot(session, headed, executablePath, runDir, `step-${step.id}-preresult`, browserArgs, profilePath);
    let ref = pickFirstResultLink(snap.refs || {});
    if (!ref) {
      const q = String(step.query || extractQuery(ctx.goal) || 'openai').trim() || 'openai';
      await ensureSearchResults(ctx, q);
      snap = await safeSnapshot(session, headed, executablePath, runDir, `step-${step.id}-preresult-retry`, browserArgs, profilePath);
      ref = pickFirstResultLink(snap.refs || {});
    }
    if (!ref) {
      if (supervised) {
        await askHuman('[HITL] Results not visible. Please click the first result.', hitlAuto);
        return;
      }
      throw new Error('Result link not found');
    }
    if (!dryRun) {
      try {
        runAgentBrowser([...baseArgs, 'click', `@${ref}`]);
        ctx.lastActionMeta = { action: 'click', ref };
      } catch {
        snap = await snapshot(session, headed, executablePath, runDir, `step-${step.id}-preresult-retry`, browserArgs, profilePath);
        ref = pickFirstResultLink(snap.refs || {});
        if (ref) {
          runAgentBrowser([...baseArgs, 'click', `@${ref}`]);
          ctx.lastActionMeta = { action: 'click', ref, retry: true };
        }
      }
      waitForLoad(session, headed, executablePath, browserArgs, profilePath);
    }
  } else if (step.intent === 'click') {
    const snap = await snapshot(session, headed, executablePath, runDir, `step-${step.id}-preclick`, browserArgs, profilePath);
    const ref = pickRefByKeywords(snap.refs || {}, [normalizeText(step.target || '')]);
    if (!ref) throw new Error('Target not found');
    if (!dryRun) {
      runAgentBrowser([...baseArgs, 'click', `@${ref}`]);
      ctx.lastActionMeta = { action: 'click', ref };
      waitForLoad(session, headed, executablePath, browserArgs, profilePath);
    }
  } else if (step.intent === 'wait') {
    if (!dryRun) waitForLoad(session, headed, executablePath, browserArgs, profilePath);
  } else if (step.intent === 'verify') {
    // no-op verify; snapshot for record
  }

  if (wantSnapshots) {
    const shotPath = path.join(runDir, `step-${step.id}.png`);
    const shotArgs = [...baseArgs, 'screenshot'];
    if (fullPage) shotArgs.push('--full');
    shotArgs.push(shotPath);
    runAgentBrowser(shotArgs);
  }
  await snapshot(session, headed, executablePath, runDir, `step-${step.id}-post`, browserArgs, profilePath);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.help) return printHelp();

  const cliCfg = loadConfig(flags.config || DEFAULTS.configPath);
  const model = flags.model || cliCfg.model || DEFAULTS.model;
  const visionModel = flags['vision-model'] || cliCfg.visionModel || DEFAULTS.visionModel || model;
  const host = flags.host || cliCfg.host || DEFAULTS.host;
  const headed = flags.headed === true || cliCfg.headed || DEFAULTS.headed;
  const supervised = flags.supervised === true || cliCfg.supervised || DEFAULTS.supervised;
  const hitlAuto = flags['hitl-auto'] === true || cliCfg.hitlAuto || DEFAULTS.hitlAuto;
  const planOnly = flags['plan-only'] === true || cliCfg.planOnly || DEFAULTS.planOnly;
  const dryRun = flags['dry-run'] === true || cliCfg.dryRun || DEFAULTS.dryRun;
  const fullPage = flags['full-page'] === true || cliCfg.fullPage || DEFAULTS.fullPage;
  const viewport = flags.viewport || cliCfg.viewport || DEFAULTS.viewport;
  const resetDaemon = flags['reset-daemon'] === true || cliCfg.resetDaemon || DEFAULTS.resetDaemon;
  const executablePath = flags['executable-path'] || cliCfg.executablePath || DEFAULTS.executablePath;
  const verbose = flags.verbose === true || cliCfg.verbose || DEFAULTS.verbose;
  const visionPointer = flags['vision-pointer'] === true || cliCfg.visionPointer || DEFAULTS.visionPointer;
  const userDataDir = flags['user-data-dir'] || cliCfg.userDataDir || DEFAULTS.userDataDir;
  const profileArg = flags.profile || cliCfg.profile || DEFAULTS.profile;
  const cdp = flags.cdp || cliCfg.cdp || DEFAULTS.cdp;
  const cdpAuto = flags['cdp-auto'] === true || cliCfg.cdpAuto || DEFAULTS.cdpAuto;
  const closeChrome = flags['close-chrome'] === true || cliCfg.closeChrome || DEFAULTS.closeChrome;
  const normalizedExe = executablePath ? executablePath.replace(/\\\\\\\\/g, '\\\\') : executablePath;
  const session = flags.session || `run-${Date.now()}`;

  const runDir = path.join('artifacts', `run-${Date.now()}`);
  ensureDir(runDir);

  if (flags['list-profiles']) {
    const profiles = getChromeProfiles(userDataDir);
    if (!profiles.length) {
      console.log(`No Chrome profiles found in ${userDataDir || '<unknown>'}`);
      return;
    }
    console.log(`Chrome profiles in ${userDataDir}:`);
    profiles.forEach((p) => console.log(`- ${p.name} (${p.dir})`));
    return;
  }

  const goal = positional.join(' ').trim();
  if (!goal) {
    console.error('Goal text is required.');
    process.exit(1);
  }

  const steps = await generatePlan(goal, model, host);
  const planMd = planToMarkdown(steps);
  fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify(steps, null, 2));
  fs.writeFileSync(path.join(runDir, 'plan.md'), planMd);



  if (planOnly) {
    console.log(`Plan written to ${runDir}`);
    return;
  }

  const wantSnapshots = /snapshot/i.test(goal);
  let browserArgs = null;
  let profilePath = '';
  let profileLocked = false;
  let profileDir = '';
  if (userDataDir) {
    const profiles = getChromeProfiles(userDataDir);
    if (profileArg) {
      const needle = String(profileArg).toLowerCase();
      const match = profiles.find((p) => p.dir.toLowerCase() === needle || p.name.toLowerCase() === needle);
      if (match) {
        profileDir = match.dir;
      } else if (fs.existsSync(profileArg) || /[\\/]/.test(profileArg)) {
        profilePath = profileArg;
      } else {
        profileDir = profileArg;
      }
    } else if (profiles.length > 1) {
      profileDir = await pickProfileInteractively(profiles);
    } else if (profiles.length === 1) {
      profileDir = profiles[0].dir;
    }
    if (!profilePath && profileDir) {
      profilePath = userDataDir;
      browserArgs = `--profile-directory=${profileDir}`;
    }
    if (profilePath) {
      logVerbose(verbose, 'using chrome profile', { userDataDir, profileDir: profileDir || null, profilePath, browserArgs });
      profileLocked = isProfileLocked(profilePath);
      if (profilePath === userDataDir && isChromeRunning()) {
        profileLocked = true;
        logVerbose(verbose, 'chrome appears running; treating profile as locked');
      }
    }
  }
  if (profileLocked && closeChrome) {
    closeChromeBestEffort(verbose);
    waitForDaemonShutdown();
    profileLocked = isProfileLocked(profilePath);
    if (profilePath === userDataDir && isChromeRunning()) {
      profileLocked = true;
    }
    if (!profileLocked) {
      logVerbose(verbose, 'chrome closed; proceeding with profile launch');
    }
  }
  if (!cdp && cdpAuto && profileLocked) {
    const reachable = await isCdpReachable('9222');
    if (reachable) {
      GLOBAL_CDP = '9222';
      logVerbose(verbose, 'auto-attaching via CDP', GLOBAL_CDP);
      profilePath = '';
      browserArgs = null;
      profileLocked = false;
    } else {
      console.warn('[runner] Chrome is running but CDP is not reachable on 9222.');
      console.warn('Start Chrome with --remote-debugging-port=9222 or pass --cdp <port|url>.');
    }
  }
  if (cdp) {
    GLOBAL_CDP = cdp;
    logVerbose(verbose, 'using CDP connection', cdp);
    profilePath = '';
    browserArgs = null;
    profileLocked = false;
  }
  if (viewport) {
    console.warn('[runner] viewport flag is best-effort; using full-page screenshots for observability.');
  }
  let sessionName = session;
  let reuseExisting = false;
  let sessionNames = [];

  if (profileLocked && resetDaemon) {
    console.warn('[runner] Chrome profile is in use; ignoring --reset-daemon and reusing existing session if available.');
  }
  const forceReset = !cdp && !profileLocked && (resetDaemon || flags.viewport || flags['executable-path'] || flags.headed || profilePath || browserArgs);

  if (forceReset) {
    closeDaemonBestEffort();
    waitForDaemonShutdown();
    cleanupDaemonArtifacts(sessionName);
  }

  if (profileLocked) {
    try {
      const sessions = runAgentBrowser(['session', 'list', '--json'], { timeoutMs: 5000, retryOnDaemon: false, verbose });
      const list = Array.isArray(sessions?.sessions) ? sessions.sessions : (Array.isArray(sessions) ? sessions : []);
      const names = list.map((s) => (typeof s === 'string' ? s : s?.name)).filter(Boolean);
      sessionNames = names;
    } catch {
      // ignore if daemon not running
    }
    if (!flags.session && sessionNames.length) {
      sessionName = sessionNames[0];
      reuseExisting = true;
      logVerbose(verbose, 'profile locked; reusing existing session', { sessionName });
    } else if (!flags.session && !sessionNames.length) {
      throw new Error('Chrome is running but there is no agent-browser session to reuse. Close Chrome (or use --close-chrome), or start it with --remote-debugging-port=9222 and pass --cdp 9222.');
    }
  }

  if (reuseExisting) {
    browserArgs = null;
    profilePath = '';
  }
  const ctx = { session: sessionName, headed, executablePath: reuseExisting ? null : normalizedExe, runDir, wantSnapshots, goal, dryRun, supervised, hitlAuto, fullPage: fullPage || wantSnapshots, browserArgs, profilePath, model, visionModel, host, verbose, visionPointer };
  VERBOSE = verbose;

  if (reuseExisting) {
    try {
      runAgentBrowser(['--session', sessionName, 'tab', 'new'], { timeoutMs: 10000, retryOnDaemon: false, verbose });
    } catch {
      // ignore
    }
  }
  if (GLOBAL_CDP) {
    try {
      runAgentBrowser(['--cdp', GLOBAL_CDP, 'tab', 'new'], { timeoutMs: 10000, retryOnDaemon: false, verbose });
    } catch {
      // ignore
    }
  }

    for (const step of steps) {
      const startInfo = getPageInfo(sessionName, headed, ctx.executablePath, browserArgs, ctx.profilePath);
      let err = null;
      try {
        if (step.intent === 'open_url') {
          await executeStep(step, ctx);
          const blocker = await handleBlockers(sessionName, headed, ctx.executablePath, runDir, step.id, supervised, hitlAuto, dryRun, browserArgs, ctx);

          if (blocker && blocker.handled && !blocker.cleared) {
            if (!supervised) throw new Error('Blocker not cleared');
          }
        } else {
          const blocker = await handleBlockers(sessionName, headed, ctx.executablePath, runDir, step.id, supervised, hitlAuto, dryRun, browserArgs, ctx);

          if (blocker && blocker.handled && !blocker.cleared) {
            if (!supervised) throw new Error('Blocker not cleared');
          }
          await executeStep(step, ctx);
        }
      } catch (e) {
        err = String(e?.message || e);
      }
      const endInfo = getPageInfo(sessionName, headed, ctx.executablePath, browserArgs, ctx.profilePath);
      if (isCaptchaUrl(endInfo.url)) {
        if (supervised && !hitlAuto) {
          await askHuman('[HITL] CAPTCHA/verification detected. Please solve it, then press Enter to continue.', hitlAuto);
        } else {
          throw new Error('CAPTCHA/verification detected. Re-run without --hitl-auto or solve manually.');
        }
      }
      const obsSnap = await safeSnapshot(sessionName, headed, ctx.executablePath, runDir, `step-${step.id}-observe`, browserArgs, ctx.profilePath);
      const ok = evaluateStep(step, startInfo, endInfo, obsSnap);
    let meta = ctx.lastActionMeta ? { ...ctx.lastActionMeta } : null;
    if (ctx.lastBlockerMeta) {
      if (meta) meta.blocker = ctx.lastBlockerMeta;
      else meta = { blocker: ctx.lastBlockerMeta };
    }
    const fatal = err && err.includes('Daemon failed to start');
    appendReport(runDir, {
      stepId: step.id,
      intent: step.intent,
      title: step.title,
      start: startInfo,
      end: endInfo,
      ok,
      error: err,
      meta,
    });
    ctx.lastActionMeta = null;
    ctx.lastBlockerMeta = null;

    if (fatal) {
      throw new Error(err);
    }

    if (!ok) {
        if (supervised) {
          if (hitlAuto && (step.intent === 'search' || step.intent === 'click_first_result')) {
          const blocker = await handleBlockers(sessionName, headed, ctx.executablePath, runDir, step.id, supervised, hitlAuto, dryRun, browserArgs, ctx);

            if (blocker && blocker.handled && !blocker.cleared) {
              if (!supervised) throw new Error('Blocker not cleared');
            }
          await executeStep(step, ctx);
        }
        await askHuman(`[HITL] Step ${step.id} not verified. Fix manually then press Enter to continue.`, hitlAuto);
      } else {
        throw new Error(`Step ${step.id} failed to verify`);
      }
    }
    await sleep(300);
  }

  console.log(`Plan completed. Artifacts in ${runDir}`);
}

main().catch((err) => {
  console.error('Fatal error', err);
  process.exit(1);
});
