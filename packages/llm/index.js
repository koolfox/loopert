import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { randomUUID } from 'crypto';
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

  const autonomy =
    plan.autonomy_level ||
    plan.autonomyLevel ||
    plan.capability_profile ||
    fallbackAutonomy ||
    DEFAULT_AUTONOMY;

  return {
    reasoning_summary: plan.reasoning_summary || plan.summary || '',
    plan_id: plan.plan_id || plan.planId || createPlanId(),
    autonomy_level: autonomy,
    steps: normalizedSteps
  };
}

function buildMessages(input, policyHint) {
  const { goal, context, capability_profile, tool_catalog } = input;
  const toolList = Array.isArray(tool_catalog)
    ? tool_catalog.map((t) => `${t.name}${t.risk_level ? ` (risk: ${t.risk_level})` : ''}`).join(', ')
    : ALLOWED_TOOLS.join(', ');
  const contextBlock =
    context && typeof context === 'object' ? `Context:\n${JSON.stringify(context, null, 2)}` : null;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Goal: ${goal}`,
        capability_profile ? `Capability profile: ${capability_profile}` : null,
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
    capabilityProfile
  } = options;

  const toolCatalog =
    goalPayload.tool_catalog ||
    toolCatalogOpt ||
    toolCatalogAlt ||
    ALLOWED_TOOLS.map((name) => ({ name, risk_level: name === 'navigate' || name === 'type' ? 'medium' : 'low' }));

  const capability_profile = goalPayload.capability_profile || capabilityProfile || DEFAULT_AUTONOMY;
  const context = goalPayload.context;

  const client = createClient(host);
  let messages = buildMessages({ goal, context, capability_profile, tool_catalog: toolCatalog }, policyHint);
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
