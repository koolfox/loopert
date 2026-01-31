import { planGoal, validatePlan as validatePlanSchema } from '@loopert/llm';
import fs from 'fs';
import { exec } from 'child_process';
import kleur from 'kleur';
import path from 'path';
import yaml from 'js-yaml';
import { chromium } from 'playwright';

const DEFAULT_MIN_ACTION_INTERVAL_MS = 250;
const DEFAULT_WAIT_MS = 800;
const BASE_TOOL_CATALOG = [
  { name: 'navigate', schema: 'navigate({ url })', risk_level: 'medium', description: 'Change page' },
  { name: 'click', schema: 'click({ id })', risk_level: 'low', description: 'Click element' },
  { name: 'click_point', schema: 'click_point({ point:{x,y}, button?, clickCount? })', risk_level: 'medium', description: 'Click by screen coordinates' },
  { name: 'drag', schema: 'drag({ from:{x,y}, to:{x,y}, durationMs? })', risk_level: 'medium', description: 'Drag from A to B' },
  { name: 'type', schema: 'type({ id, text })', risk_level: 'medium', description: 'Fill text' },
  { name: 'hotkey', schema: 'hotkey({ keys:string[] })', risk_level: 'medium', description: 'Send chorded keys' },
  { name: 'long_press', schema: 'long_press({ point:{x,y}, durationMs? })', risk_level: 'medium', description: 'Press and hold at point' },
  { name: 'scroll', schema: 'scroll({ deltaY })', risk_level: 'low', description: 'Scroll viewport' },
  { name: 'wait_for_idle', schema: 'wait_for_idle({ timeoutMs })', risk_level: 'low', description: 'Wait for idle' },
  { name: 'snapshot', schema: 'snapshot()', risk_level: 'low', description: 'Capture screenshot' }
];

const EXTENDED_TOOL_CATALOG = [
  { name: 'shell', schema: 'shell({ cmd, timeoutMs? })', risk_level: 'high', description: 'Run OS shell command' },
  { name: 'read_file', schema: 'read_file({ path, encoding? })', risk_level: 'medium', description: 'Read local file' },
  { name: 'write_file', schema: 'write_file({ path, content, encoding? })', risk_level: 'high', description: 'Write local file' },
  {
    name: 'fetch',
    schema: 'fetch({ url, method?, headers?, body? })',
    risk_level: 'medium',
    description: 'HTTP request and return status/body snippet'
  }
];

function buildToolCatalog(profileName) {
  if (['pro', 'auto', 'unleashed'].includes(profileName)) {
    return [...BASE_TOOL_CATALOG, ...EXTENDED_TOOL_CATALOG];
  }
  return BASE_TOOL_CATALOG;
}

const DEFAULT_TOOL_CATALOG = BASE_TOOL_CATALOG;
const DEFAULT_GUARDRAILS = {
  source: 'built-in-default',
  profiles: {
    default: {
      description: 'Conservative defaults for manual review',
      max_steps: 12,
      blocked_tools: ['shell', 'write_file'],
      allow_password: false,
      require_origin_confirmation: true,
      autonomy_level: 'assisted'
    },
    pro: {
      description: 'Lenient but still safe profile',
      max_steps: 25,
      blocked_tools: ['shell', 'write_file'],
      allow_password: false,
      require_origin_confirmation: true,
      autonomy_level: 'semi_auto'
    },
    auto: {
      description: 'Highest autonomy; still no password fields',
      max_steps: 30,
      blocked_tools: [],
      allow_password: true,
      require_origin_confirmation: false,
      autonomy_level: 'auto'
    },
    unleashed: {
      description: 'Unrestricted. User accepts full risk.',
      max_steps: 40,
      blocked_tools: [],
      allow_password: true,
      require_origin_confirmation: false,
      autonomy_level: 'auto'
    },
    mobile: {
      description: 'Mobile/touch profile with coordinate tools enabled, shell blocked',
      max_steps: 25,
      blocked_tools: ['shell', 'write_file'],
      allow_password: false,
      require_origin_confirmation: true,
      autonomy_level: 'semi_auto'
    }
  }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function resolvePointAbs(point, page) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const size = page.viewportSize() || { width: 1280, height: 720 };
  const norm =
    Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1
      ? { x: point.x * size.width, y: point.y * size.height }
      : point;
  return { x: Math.max(0, norm.x), y: Math.max(0, norm.y) };
}

function clipPointToViewport(point, viewport) {
  if (!point) return null;
  const w = viewport?.width ?? 1280;
  const h = viewport?.height ?? 720;
  return {
    x: Math.min(Math.max(point.x, 0), w),
    y: Math.min(Math.max(point.y, 0), h)
  };
}

function formatStep(step, index) {
  return `${index + 1}. ${step.tool} ${JSON.stringify(step.args)}`;
}

async function enforceRateLimit(lastActionAt, minIntervalMs = DEFAULT_MIN_ACTION_INTERVAL_MS) {
  const elapsed = Date.now() - lastActionAt.value;
  if (elapsed < minIntervalMs) {
    const waitMs = minIntervalMs - elapsed;
    await sleep(waitMs);
  }
  lastActionAt.value = Date.now();
}

function resolveGuardrailPath(configPath) {
  if (!configPath) return null;
  return path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
}

function loadGuardrailDoc(configPath) {
  const resolved = resolveGuardrailPath(configPath);
  if (resolved && fs.existsSync(resolved)) {
    try {
      const raw = fs.readFileSync(resolved, 'utf8');
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === 'object') {
        return { ...parsed, source: resolved };
      }
    } catch (err) {
      return { ...DEFAULT_GUARDRAILS, source: `${resolved} (parse_error: ${err.message})` };
    }
  }
  return { ...DEFAULT_GUARDRAILS };
}

function selectGuardrailProfile(doc, profileName) {
  const profiles = doc?.profiles || {};
  if (profileName && profiles[profileName]) {
    return { profileName, profile: profiles[profileName] };
  }
  if (profiles.default) {
    return { profileName: 'default', profile: profiles.default };
  }
  const firstKey = Object.keys(profiles)[0];
  if (firstKey) {
    return { profileName: firstKey, profile: profiles[firstKey] };
  }
  return { profileName: profileName || 'default', profile: {} };
}

function loadGuardrails({ configPath, profileName }) {
  const doc = loadGuardrailDoc(configPath);
  const { profileName: selectedName, profile } = selectGuardrailProfile(doc, profileName);
  return {
    source: doc.source || 'built-in-default',
    profileName: selectedName,
    profile,
    doc
  };
}

function buildPolicyHint(profile, toolCatalog = DEFAULT_TOOL_CATALOG) {
  if (!profile) return '';
  const lines = [];
  if (profile.description) lines.push(profile.description);
  if (Array.isArray(toolCatalog) && toolCatalog.length) {
    lines.push(`Allowed tools: ${toolCatalog.map((t) => t.name).join(', ')}.`);
  }
  if (profile.max_steps) {
    lines.push(`Do not propose more than ${profile.max_steps} steps.`);
  }
  if (Array.isArray(profile.blocked_tools) && profile.blocked_tools.length) {
    lines.push(`Never use tools: ${profile.blocked_tools.join(', ')}.`);
  }
  if (profile.allow_password === false) {
    lines.push('Never type into password/secret fields or ids containing "password" or "pwd".');
  }
  if (profile.require_origin_confirmation) {
    lines.push('Avoid cross-origin navigation unless clearly necessary.');
  }
  if (profile.autonomy_level) {
    lines.push(`Target autonomy level: ${profile.autonomy_level}.`);
  }
  return lines.join('\n');
}

function validatePlanAgainst(plan, profile, toolCatalog = DEFAULT_TOOL_CATALOG) {
  if (!plan || !Array.isArray(plan.steps)) {
    return { error: 'invalid_plan', details: 'Plan missing steps array' };
  }
  const allowedTools = new Set(toolCatalog?.map((t) => t.name) || []);
  const blockedTools = new Set(profile?.blocked_tools || []);
  if (profile?.max_steps && plan.steps.length > profile.max_steps) {
    return { error: 'max_steps_exceeded', details: { max: profile.max_steps, actual: plan.steps.length } };
  }

  for (const [idx, step] of plan.steps.entries()) {
    if (!allowedTools.has(step.tool)) {
      return { error: 'unknown_tool', details: { step: idx, tool: step.tool } };
    }
    if (blockedTools.has(step.tool)) {
      return { error: 'tool_blocked', details: { step: idx, tool: step.tool } };
    }
    if (profile?.allow_password === false && step.tool === 'type') {
      const id = String(step.args?.id || '').toLowerCase();
      if (id.includes('password') || id.includes('pwd')) {
        return { error: 'password_field_blocked', details: { step: idx } };
      }
    }
  }

  return { ok: true };
}

async function normalizeCoordinates(plan, page, logger) {
  if (!plan?.steps?.length) return plan;
  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  const clamp = (pt) => clipPointToViewport(pt, viewport);

  const adjustPoint = async (pt) => {
    const abs = await resolvePointAbs(pt, page);
    return clamp(abs);
  };

  const adjustedSteps = [];
  for (const [idx, step] of plan.steps.entries()) {
    let s = { ...step };
    if (s.tool === 'click_point' && s.args?.point) {
      const fixed = await adjustPoint(s.args.point);
      if (!fixed) {
        if (logger) logger(`skip step ${idx + 1}: invalid point`);
        continue;
      }
      s = { ...s, args: { ...s.args, point: fixed } };
    } else if (s.tool === 'drag') {
      const from = await adjustPoint(s.args?.from);
      const to = await adjustPoint(s.args?.to);
      if (!from || !to) {
        if (logger) logger(`skip step ${idx + 1}: invalid drag points`);
        continue;
      }
      s = { ...s, args: { ...s.args, from, to } };
    } else if (s.tool === 'long_press' && s.args?.point) {
      const fixed = await adjustPoint(s.args.point);
      if (!fixed) {
        if (logger) logger(`skip step ${idx + 1}: invalid long_press point`);
        continue;
      }
      s = { ...s, args: { ...s.args, point: fixed } };
    }
    adjustedSteps.push(s);
  }
  return { ...plan, steps: adjustedSteps };
}

function scoreCandidate(text, keyLower) {
  if (!text) return 0;
  const t = text.toLowerCase();
  if (t === keyLower) return 3;
  if (t.includes(keyLower)) return 2;
  if (keyLower.includes(t)) return 1.5;
  return 0;
}

function findInteractableByLabel(interactables, key) {
  if (!key || !Array.isArray(interactables)) return null;
  const keyLower = key.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const cand of interactables) {
    const score =
      scoreCandidate(cand.id, keyLower) * 1.2 +
      scoreCandidate(cand.label, keyLower) +
      scoreCandidate(cand.locatorHint, keyLower) * 0.8 +
      scoreCandidate(cand.role, keyLower) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return bestScore >= 1 ? best : null;
}

function bboxCenter(bbox) {
  if (!bbox) return null;
  const { x, y, width, height, centerX, centerY } = bbox;
  if (Number.isFinite(centerX) && Number.isFinite(centerY)) return { x: centerX, y: centerY };
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height)) {
    return { x: x + width / 2, y: y + height / 2 };
  }
  return null;
}

async function collectInteractables(page) {
  try {
    return await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll(
          'button, a, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]'
        )
      );
      return nodes.slice(0, 150).map((el, idx) => {
        const rect = el.getBoundingClientRect();
        const id = el.id || '';
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const type = el.getAttribute('type') || el.tagName.toLowerCase();
        const aria = el.getAttribute('aria-label') || '';
        const placeholder = el.getAttribute('placeholder') || '';
        const text = (el.innerText || '').trim();
      const label =
        aria ||
        placeholder ||
        text.slice(0, 120) ||
        id ||
        `${role}-${idx}`;
      const locatorHint = id ? `#${id}` : text ? text.slice(0, 50) : label.slice(0, 50);
      return {
        id: id || label || `node-${idx}`,
        role,
        type,
        label,
        locatorHint,
        bbox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          centerX: rect.x + rect.width / 2,
          centerY: rect.y + rect.height / 2
        }
      };
    });
  });
  } catch (_) {
    return [];
  }
}

async function collectSnapshot(page, { includeScreenshot = true } = {}) {
  const url = page.url();
  const origin = url ? new URL(url).origin : '';
  let screenshot = undefined;
  const viewport = page.viewportSize() || {};
  const deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio).catch(() => undefined);
  if (includeScreenshot) {
    try {
      screenshot = await page.screenshot({ fullPage: true, encoding: 'base64' });
    } catch (_) {
      screenshot = undefined;
    }
  }
  const interactables = await collectInteractables(page);
  const title = await page.title().catch(() => '');
  return {
    page: {
      url,
      origin,
      title,
      interactables
    },
    visual: {
      screenshot,
      visionFeatures: {},
      viewport: {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor
      }
    }
  };
}


function cssEscape(value) {
  // Minimal CSS.escape fallback
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

async function resolveLocator(page, key) {
  const target = String(key || '').trim();
  if (!target) throw new Error('selector_missing_key');

  const candidates = [
    { desc: 'id', locator: page.locator(`#${cssEscape(target)}`) },
    { desc: 'name', locator: page.locator(`[name="${target}"]`) },
    { desc: 'aria-label', locator: page.getByLabel(target) },
    { desc: 'placeholder', locator: page.locator(`[placeholder="${target}"]`) },
    { desc: 'text', locator: page.getByText(target).first() }
  ];

  for (const { locator } of candidates) {
    try {
      const handle = await locator.first().elementHandle({ timeout: 1500 });
      if (handle) {
        return locator.first();
      }
    } catch (err) {
      // continue to next candidate
    }
  }

  throw new Error('selector_not_found');
}

async function confirmOriginChange(currentOrigin, targetUrl, confirmOriginChange) {
  if (!confirmOriginChange || !currentOrigin) return true;
  const nextOrigin = new URL(targetUrl).origin;
  if (nextOrigin === currentOrigin) return true;
  return confirmOriginChange(currentOrigin, nextOrigin);
}

async function takeSnapshot(page, artifactsDir) {
  ensureDir(artifactsDir);
  const file = path.join(
    artifactsDir,
    `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
  );
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function assertNotKilled(killSignal) {
  if (killSignal?.aborted) {
    throw new Error('killed');
  }
}

async function dismissCookies(page, logger) {
  const labels = [
    'Reject all',
    'Reject All',
    'Reject',
    'Accept all',
    'Accept All',
    'Accept',
    'Allow all',
    'Allow All',
    'Agree',
    'I agree',
    'Continue without accepting',
    'Continue without consenting'
  ];
  for (const label of labels) {
    try {
      const btn = page.getByRole('button', { name: label, exact: false }).first();
      const handle = await btn.elementHandle({ timeout: 400 });
      if (handle) {
        await btn.click({ timeout: 800 });
        if (logger) logger(`cookie dismiss: clicked "${label}"`);
        return true;
      }
    } catch (_) {
      // try next
    }
  }
  // fallback: try links
  for (const label of labels) {
    try {
      const link = page.getByText(label, { exact: false }).first();
      const handle = await link.elementHandle({ timeout: 400 });
      if (handle) {
        await link.click({ timeout: 800 });
        if (logger) logger(`cookie dismiss (text): clicked "${label}"`);
        return true;
      }
    } catch (_) {
      // continue
    }
  }
  return false;
}

async function executeStep(step, context) {
  const {
    page,
    lastActionAt,
    artifactsDir,
    confirmOriginChangeFn,
    logger,
    interactables,
    killSignal,
    cookieDismiss
  } = context;
  const minInterval = DEFAULT_MIN_ACTION_INTERVAL_MS;
  await enforceRateLimit(lastActionAt, minInterval);
  assertNotKilled(killSignal);

  switch (step.tool) {
    case 'navigate': {
      const url = step.args.url || step.args.href || step.args.target || step.args.to;
      if (!url) throw new Error('navigate_missing_url');
      const allowed = await confirmOriginChange(context.currentOrigin, url, confirmOriginChangeFn);
      if (!allowed) throw new Error('origin_change_denied');
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      context.currentOrigin = new URL(page.url()).origin;
      if (logger) logger(`navigated (${response?.status() || 'no response'}) -> ${page.url()}`);
      if (cookieDismiss) {
        await dismissCookies(page, logger);
      }
      break;
    }
    case 'click': {
      const key = step.args.id;
      if (!key) throw new Error('click_missing_id');
      let locator = null;
      try {
        locator = await resolveLocator(page, key);
      } catch (err) {
        const match = findInteractableByLabel(interactables, key);
        const pt = bboxCenter(match?.bbox);
        if (pt) {
          await page.mouse.click(pt.x, pt.y, { timeout: 8000 });
          break;
        }
        throw err;
      }
      await locator.click({ timeout: 8000 });
      break;
    }
    case 'click_point': {
      const point = await resolvePointAbs(step.args.point, page);
      const button = step.args.button || 'left';
      const clickCount = step.args.clickCount || 1;
      if (!point) {
        throw new Error('click_point_missing_xy');
      }
      await page.mouse.move(point.x, point.y);
      for (let i = 0; i < clickCount; i++) {
        await page.mouse.click(point.x, point.y, { button });
      }
      break;
    }
    case 'drag': {
      const { durationMs = 400 } = step.args;
      const from = await resolvePointAbs(step.args.from, page);
      const to = await resolvePointAbs(step.args.to, page);
      if (!from || !to) {
        // attempt bbox-based fallback if ids provided
        const fromMatch = findInteractableByLabel(interactables, step.args.fromId);
        const toMatch = findInteractableByLabel(interactables, step.args.toId);
        const fromPt = bboxCenter(fromMatch?.bbox);
        const toPt = bboxCenter(toMatch?.bbox);
        if (!fromPt || !toPt) {
          throw new Error('drag_missing_points');
        }
        await page.mouse.move(fromPt.x, fromPt.y);
        await page.mouse.down();
        await page.mouse.move(toPt.x, toPt.y, { steps: 10 });
        await page.waitForTimeout(Number(durationMs));
        await page.mouse.up();
        break;
      }
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await page.waitForTimeout(Number(durationMs));
      await page.mouse.up();
      break;
    }
    case 'hotkey': {
      const keys = step.args.keys;
      if (!Array.isArray(keys) || !keys.length) throw new Error('hotkey_missing_keys');
      for (const key of keys) {
        await page.keyboard.down(key);
      }
      for (const key of [...keys].reverse()) {
        await page.keyboard.up(key);
      }
      break;
    }
    case 'long_press': {
      const point = await resolvePointAbs(step.args.point, page);
      const duration = Number(step.args.durationMs || 800);
      if (!point) {
        const match = findInteractableByLabel(interactables, step.args.id || step.args.label);
        const pt = bboxCenter(match?.bbox);
        if (!pt) throw new Error('long_press_missing_xy');
        await page.mouse.move(pt.x, pt.y);
        await page.mouse.down();
        await page.waitForTimeout(duration);
        await page.mouse.up();
        break;
      }
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.waitForTimeout(duration);
      await page.mouse.up();
      break;
    }
    case 'type': {
      const { id, text } = step.args;
      if (!id) throw new Error('type_missing_id');
      const locator = await resolveLocator(page, id);
      await locator.fill(text ?? '', { timeout: 8000 });
      break;
    }
    case 'scroll': {
      const deltaY = Number(step.args.deltaY ?? step.args.y ?? 500);
      await page.mouse.wheel(0, deltaY);
      break;
    }
    case 'wait_for_idle': {
      const timeoutMs = Number(step.args.timeoutMs ?? DEFAULT_WAIT_MS);
      let elapsed = 0;
      const chunk = 100;
      while (elapsed < timeoutMs) {
        assertNotKilled(killSignal);
        const slice = Math.min(chunk, timeoutMs - elapsed);
        await page.waitForTimeout(slice);
        elapsed += slice;
      }
      break;
    }
    case 'snapshot': {
      const file = await takeSnapshot(page, artifactsDir);
      if (logger) logger(`snapshot saved: ${file}`);
      break;
    }
    case 'fetch': {
      const url = step.args.url;
      if (!url) throw new Error('fetch_missing_url');
      const method = (step.args.method || 'GET').toUpperCase();
      const init = {
        method,
        headers: step.args.headers || {},
        body: step.args.body
      };
      const res = await fetch(url, init);
      const text = await res.text();
      const preview = text.slice(0, 400);
      if (logger) logger(`fetch ${method} ${url} -> ${res.status} (${preview.length} chars preview)`);
      break;
    }
    case 'read_file': {
      const targetPath = step.args.path;
      const encoding = step.args.encoding || 'utf8';
      if (!targetPath) throw new Error('read_file_missing_path');
      const content = fs.readFileSync(targetPath, encoding);
      if (logger) logger(`read_file ${targetPath} (${content.length} chars)`);
      break;
    }
    case 'write_file': {
      const targetPath = step.args.path;
      const content = step.args.content ?? '';
      const encoding = step.args.encoding || 'utf8';
      if (!targetPath) throw new Error('write_file_missing_path');
      ensureDir(path.dirname(targetPath));
      fs.writeFileSync(targetPath, content, { encoding });
      if (logger) logger(`write_file ${targetPath} (${String(content).length} chars)`);
      break;
    }
    case 'shell': {
      const cmd = step.args.cmd;
      const timeoutMs = Number(step.args.timeoutMs || 15000);
      if (!cmd) throw new Error('shell_missing_cmd');
      await new Promise((resolve, reject) => {
        const child = exec(cmd, { timeout: timeoutMs }, (error, stdout, stderr) => {
          if (logger) {
            if (stdout) logger(`shell stdout: ${stdout.slice(0, 800)}`);
            if (stderr) logger(`shell stderr: ${stderr.slice(0, 400)}`);
          }
          if (error) {
            reject(new Error(`shell_failed:${error.code ?? 'err'}`));
          } else {
            resolve();
          }
        });
        child.on('error', reject);
      });
      break;
    }
    default:
      throw new Error(`unsupported_tool_${step.tool}`);
  }
}

export async function runPocSession(options) {
  const {
    goal,
    model,
    host,
    profile = 'default',
    configPath,
    precomputedPlan,
    headless = false,
    devtools = false,
    cookieDismiss = false,
    confirmPlan,
    confirmOriginChange: confirmOriginChangeFn,
    onUpdate = () => { },
    killSignal,
    artifactsDir = path.join(process.cwd(), 'artifacts'),
    llmLog = 'snippet',
    promptVariant = null
  } = options;

  const logger = (msg) => onUpdate(msg);

  if (!confirmPlan) {
    return { status: 'policy_error', detail: 'confirm_required_not_provided' };
  }

  const toolCatalog = buildToolCatalog(profile);
  const guardrails = loadGuardrails({ configPath, profileName: profile });
  const policyHint = buildPolicyHint(guardrails.profile, toolCatalog);
  const capabilityProfile = guardrails.profile?.autonomy_level || 'assisted';
  onUpdate(
    kleur.gray(
      `Guardrail profile: ${guardrails.profileName} (source: ${guardrails.source || 'built-in'})`
    )
  );

  let planSource = 'planner';
  let plan;
  let llmRaw = null;
  const effectiveModel = model || process.env.OLLAMA_MODEL || 'llama3.1';
  const browser = await chromium.launch({ headless, devtools });
  const context = await browser.newContext();
  const page = await context.newPage();
  const lastActionAt = { value: 0 };
  const execContext = {
    page,
    artifactsDir,
    lastActionAt,
    currentOrigin: null,
    confirmOriginChangeFn,
    logger,
    killSignal,
    cookieDismiss
  };

  try {
    if (precomputedPlan) {
      const validation = validatePlanSchema(precomputedPlan);
      if (validation.error) {
        await browser.close();
        return { status: 'planner_error', detail: validation };
      }
      plan = validation.plan;
      planSource = 'precomputed';
    } else {
      onUpdate(
        kleur.cyan(
          `Planning for goal: "${goal}" (model: ${effectiveModel}, host: ${host || 'default'})`
        )
      );
      const snapshot = await collectSnapshot(page);
      const plannerInput = {
        goal,
        context: snapshot,
        capability_profile: capabilityProfile,
        tool_catalog: toolCatalog
      };
      const planResult = await planGoal(plannerInput, {
        model,
        host,
        policyHint,
        toolCatalog,
        capabilityProfile,
        promptVariant
      });
      if (planResult.error) {
        const detailMsg =
          planResult.details && Array.isArray(planResult.details)
            ? JSON.stringify(planResult.details)
            : planResult.details || '';
        const rawMsg = planResult.raw ? ` Raw: ${String(planResult.raw).slice(0, 400)}...` : '';
        onUpdate(
          kleur.red(
            `Planner error (${planResult.error}) ${detailMsg ? `details=${detailMsg}` : ''}${rawMsg}`
          )
        );
        await browser.close();
        return { status: 'planner_error', detail: planResult };
      }
      plan = planResult.plan;
      llmRaw = planResult.raw;
    }

    // coordinate normalization and clipping
    plan = await normalizeCoordinates(plan, page, logger);

    if (llmRaw) {
      if (llmLog === 'off') {
        // no logging
      } else if (llmLog === 'full') {
        onUpdate(kleur.gray(`LLM raw response: ${llmRaw}`));
      } else {
        const snippet = llmRaw.length > 600 ? `${llmRaw.slice(0, 600)}…` : llmRaw;
        onUpdate(kleur.gray(`LLM raw response: ${snippet}`));
      }
    }

    const policyCheck = validatePlanAgainst(plan, guardrails.profile, toolCatalog);
    if (policyCheck.error) {
      onUpdate(
        kleur.red(
          `Plan blocked by guardrails: ${policyCheck.error}${policyCheck.details ? ` details=${JSON.stringify(policyCheck.details)}` : ''
          }`
        )
      );
      await browser.close();
      return { status: 'policy_block', detail: policyCheck };
    }

    onUpdate(kleur.gray(`Plan source: ${planSource}`));
    onUpdate(kleur.green('Plan ready:'));
    plan.steps.forEach((step, idx) => onUpdate(formatStep(step, idx)));

    if (confirmPlan) {
      const approved = await confirmPlan(plan);
      if (!approved) {
        await browser.close();
        return { status: 'rejected_by_user' };
      }
    }

    for (const [idx, step] of plan.steps.entries()) {
      if (killSignal?.aborted) {
        throw new Error('killed');
      }
      logger(kleur.yellow(`Executing step ${idx + 1}/${plan.steps.length}: ${step.tool}`));
      await executeStep(step, execContext);
    }
  } catch (err) {
    await browser.close();
    if (err.message === 'killed') {
      return { status: 'killed' };
    }
    return { status: 'failed', error: err.message };
  }

  await browser.close();
  return { status: 'ok' };
}
