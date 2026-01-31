import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import ollama, { Ollama } from 'ollama';

const ALLOWED_TOOLS = [
  'navigate',
  'click',
  'click_point',
  'drag',
  'type',
  'hotkey',
  'long_press',
  'scroll',
  'wait_for_idle',
  'snapshot',
  'fetch',
  'read_file',
  'write_file',
  'shell'
];
const DEFAULT_AUTONOMY = 'assisted';
const SYSTEM_PROMPT = `You are a planning engine. You do NOT execute actions; you ONLY return structured plans using registered tools.

Output rules:
- Return a single JSON object only (no code fences, no text outside the JSON).
- Fields: reasoning_summary (string), plan_id (string), autonomy_level ("assisted" | "semi_auto" | "auto"), steps (array of { tool, args, explanation, estimated_risk, confidence }).
- tool must be one of: ${ALLOWED_TOOLS.join(', ')}.
- estimated_risk is "low" | "medium" | "high".
- confidence is a number between 0 and 1.
- Do not invent tools or bypass policy hints.`;

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    reasoning_summary: { type: 'string' },
    plan_id: { type: 'string' },
    autonomy_level: { type: 'string', enum: ['assisted', 'semi_auto', 'auto'] },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: ALLOWED_TOOLS },
          args: { type: 'object' },
          explanation: { type: 'string' },
          estimated_risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['tool', 'args', 'explanation', 'estimated_risk', 'confidence'],
        additionalProperties: false
      }
    }
  },
  required: ['reasoning_summary', 'plan_id', 'autonomy_level', 'steps'],
  additionalProperties: false
};

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(PLAN_SCHEMA);

const PROMPT_TEMPLATES = {
  computer: [
    'You are a desktop/web UI operator.',
    'Use mouse-like actions (click_point/drag/scroll), keyboard (type/hotkey), DOM-aware actions (navigate/click/type), and utility tools (snapshot/fetch/files/shell if allowed).',
    'Prefer semantic DOM tools when an id/label is provided; otherwise fall back to coordinate tools.',
    'Interactable list may include bounding boxes (bbox); use them to choose points when IDs are missing.',
    'Avoid hallucinating elements; plan only with given goal/context.'
  ],
  mobile: [
    'You are a mobile/touch UI operator.',
    'Use touch actions (click_point as tap, long_press, drag for swipe), scroll, type, hotkey only when clearly supported.',
    'Assume soft keyboard; avoid multi-window desktop assumptions.',
    'Keep actions minimal and sequential.'
  ],
  grounding: [
    'Return only the minimal actions needed to fulfill the goal based on the screenshot and interactables.',
    'Do not add explanations unrelated to actions.',
    'Use coordinate tools when DOM ids are missing.'
  ]
};

function loadRalphPrompt() {
  const p = path.join(process.cwd(), 'scripts', 'ralph-upstream', 'prompt.md');
  if (!fs.existsSync(p)) return null;
  try {
    const text = fs.readFileSync(p, 'utf8');
    return text.slice(0, 6000); // guard size
  } catch (_) {
    return null;
  }
}

const RALPH_PROMPT = loadRalphPrompt();

function parsePlanContent(content) {
  if (!content) return { error: 'empty_response' };
  try {
    const parsed = JSON.parse(content.trim());
    return { plan: parsed };
  } catch (err) {
    return { error: 'invalid_json', details: err.message, raw: content };
  }
}

function validatePlanSchema(plan, fallbackAutonomy) {
  const normalized = normalizePlan(plan, fallbackAutonomy);
  const valid = validate(normalized);
  if (!valid) {
    return { error: 'schema_validation_failed', details: validate.errors, plan: normalized };
  }
  return { plan: normalized };
}

function normalizeArgs(tool, args) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args;
  const list = Array.isArray(args)
    ? args
    : args === undefined || args === null
      ? []
      : [args];

  const clean = (val) => {
    if (typeof val !== 'string') return val;
    return val.trim().replace(/^<(.+)>$/, '$1');
  };

  const parsePoint = (val) => {
    if (!val && val !== 0) return undefined;
    if (typeof val === 'object' && val !== null && 'x' in val && 'y' in val) {
      return { x: Number(val.x), y: Number(val.y) };
    }
    if (typeof val === 'string') {
      const parts = val.split(/[, ]+/).map(Number);
      if (parts.length >= 2 && parts.every((n) => Number.isFinite(n))) {
        return { x: parts[0], y: parts[1] };
      }
    }
    const nums = Array.isArray(val) ? val.map(Number) : [];
    if (nums.length >= 2 && nums.every((n) => Number.isFinite(n))) {
      return { x: nums[0], y: nums[1] };
    }
    return undefined;
  };

  switch (tool) {
    case 'navigate':
      return { url: clean(list[0]) };
    case 'click':
      return { id: clean(list[0]) };
    case 'click_point':
      return { point: parsePoint(list[0]) };
    case 'drag':
      return { from: parsePoint(list[0]), to: parsePoint(list[1]), durationMs: list[2] };
    case 'type':
      return { id: clean(list[0]), text: list[1] };
    case 'hotkey':
      return { keys: Array.isArray(list[0]) ? list[0] : String(list.join(' ')).split(/[+ ]+/).filter(Boolean) };
    case 'long_press':
      return { point: parsePoint(list[0]), durationMs: list[1] || 800 };
    case 'scroll':
      return { deltaY: list[0] ?? list[1] };
    case 'wait_for_idle':
      return { timeoutMs: list[0] };
    case 'snapshot':
      return {};
    case 'fetch':
      return {
        url: clean(list[0]),
        method: list[1],
        body: list[2],
        headers: list[3]
      };
    case 'read_file':
      return { path: clean(list[0]), encoding: list[1] || 'utf8' };
    case 'write_file':
      return { path: clean(list[0]), content: list[1] ?? '', encoding: list[2] || 'utf8' };
    case 'shell':
      return { cmd: list[0], timeoutMs: list[1] };
    default:
      return {};
  }
}

function clampConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.6;
  return Math.min(1, Math.max(0, num));
}

function createPlanId() {
  try {
    return `plan-${randomUUID()}`;
  } catch (_) {
    return `plan-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  }
}

function normalizePlan(plan, fallbackAutonomy = DEFAULT_AUTONOMY) {
  if (!plan || typeof plan !== 'object') return plan;
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const normalizedSteps = steps.map((step = {}) => {
    const tool = typeof step.tool === 'string' ? step.tool.trim() : '';
    const args = normalizeArgs(tool, step.args);
    const riskRaw = step.estimated_risk || step.risk || step.risk_level;
    const estimated_risk = typeof riskRaw === 'string' ? riskRaw.toLowerCase() : 'medium';
    const explanation = typeof step.explanation === 'string' ? step.explanation : step.reason || '';
    const confidence = clampConfidence(step.confidence ?? step.score);
    return { tool, args, explanation, estimated_risk, confidence };
  });

  const toStringSafe = (val) => {
    if (val === undefined || val === null) return '';
    if (typeof val === 'string') return val;
    try {
      return JSON.stringify(val);
    } catch (_) {
      return String(val);
    }
  };

  const autonomy =
    (typeof plan.autonomy_level === 'string' && plan.autonomy_level) ||
    (typeof plan.autonomyLevel === 'string' && plan.autonomyLevel) ||
    (typeof plan.capability_profile === 'string' && plan.capability_profile) ||
    fallbackAutonomy ||
    DEFAULT_AUTONOMY;

  return {
    reasoning_summary: toStringSafe(plan.reasoning_summary || plan.summary || ''),
    plan_id: plan.plan_id || plan.planId || createPlanId(),
    autonomy_level: autonomy,
    steps: normalizedSteps
  };
}

function pickPromptVariant({ capability_profile, promptVariant }) {
  if (promptVariant && PROMPT_TEMPLATES[promptVariant]) return promptVariant;
  const cap = (capability_profile || '').toLowerCase();
  if (cap.includes('mobile') || cap.includes('touch')) return 'mobile';
  return 'computer';
}

function trimContext(context) {
  if (!context || typeof context !== 'object') return context;
  const clone = JSON.parse(JSON.stringify(context));
  if (Array.isArray(clone.page?.interactables) && clone.page.interactables.length > 50) {
    clone.page.interactables = clone.page.interactables.slice(0, 50);
  }
  return clone;
}

function buildMessages(input, policyHint, promptVariant) {
  const { goal, context, capability_profile, tool_catalog } = input;
  const safeContext = trimContext(context);
  const toolList = Array.isArray(tool_catalog)
    ? tool_catalog.map((t) => `${t.name}${t.risk_level ? ` (risk: ${t.risk_level})` : ''}`).join(', ')
    : ALLOWED_TOOLS.join(', ');
  const contextBlock =
    safeContext && typeof safeContext === 'object' ? `Context:\n${JSON.stringify(safeContext, null, 2)}` : null;
  const templateKey = pickPromptVariant({ capability_profile, promptVariant });
  const templateLines = PROMPT_TEMPLATES[templateKey] || PROMPT_TEMPLATES.computer;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    RALPH_PROMPT ? { role: 'system', content: RALPH_PROMPT } : null,
    {
      role: 'user',
      content: [
        `Goal: ${goal}`,
        capability_profile ? `Capability profile: ${capability_profile}` : null,
        `Mode: ${templateKey}`,
        templateLines.join('\n'),
        `Allowed tools: ${toolList}`,
        policyHint ? `Policy constraints:\n${policyHint}` : null,
        contextBlock,
        'Return ONLY one JSON object with fields reasoning_summary, plan_id, autonomy_level, steps[{tool,args,explanation,estimated_risk,confidence}].',
        'Do not include code fences or any other text.'
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  ];
}

function createClient(host) {
  return host ? new Ollama({ host }) : ollama;
}

export async function planGoal(goalInput, options = {}) {
  const goalPayload = typeof goalInput === 'string' ? { goal: goalInput } : goalInput || {};
  const goal = goalPayload?.goal;
  if (!goal || typeof goal !== 'string' || !goal.trim()) {
    return { error: 'invalid_goal', details: 'Goal must be a non-empty string' };
  }

  const {
    model = process.env.OLLAMA_MODEL || 'llama3.1',
    host,
    policyHint,
    toolCatalog: toolCatalogOpt,
    tool_catalog: toolCatalogAlt,
    capabilityProfile,
    promptVariant: promptVariantOpt
  } = options;

  const toolCatalog =
    goalPayload.tool_catalog ||
    toolCatalogOpt ||
    toolCatalogAlt ||
    ALLOWED_TOOLS.map((name) => ({ name, risk_level: name === 'navigate' || name === 'type' ? 'medium' : 'low' }));

  const capability_profile = goalPayload.capability_profile || capabilityProfile || DEFAULT_AUTONOMY;
  const context = goalPayload.context;
  const promptVariant = goalPayload.prompt_variant || promptVariantOpt;

  const client = createClient(host);
  let messages = buildMessages(
    { goal, context, capability_profile, tool_catalog: toolCatalog },
    policyHint,
    promptVariant
  );
  let lastRaw;

  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await client.chat({
        model,
        messages,
        format: 'json'
      });
    } catch (err) {
      return { error: 'ollama_error', details: err.message };
    }

    const content = response?.message?.content;
    lastRaw = content;
    const parsed = parsePlanContent(content);
    if (!parsed.error) {
      const validated = validatePlanSchema(parsed.plan, capability_profile);
      if (!validated.error) {
        return { plan: validated.plan, raw: lastRaw, model };
      }
    }

    messages = [
      ...messages,
      { role: 'assistant', content: content || '' },
      {
        role: 'user',
        content:
          'The previous response was invalid. Respond again with ONLY one JSON object that is a valid instance of the schema (no code fences, no extra text).'
      }
    ];
  }

  return { error: 'schema_validation_failed', details: validate.errors, raw: lastRaw };
}

export function validatePlan(plan, fallbackAutonomy) {
  return validatePlanSchema(plan, fallbackAutonomy);
}

export function schemaErrors() {
  return validate.errors;
}
