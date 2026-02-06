import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { spawn } from 'child_process';

// ------------------ CLI Helpers ------------------
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.includes('=') ? a.slice(2).split('=') : [a.slice(2), argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true];
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
  console.log(`Loopert browser-use runner
Usage: node apps/desktop/index.js "<goal>" [options]
Options:
  --model <name>       Ollama model (default: qwen3-vl:4b)
  --host <url>         Ollama host (default: http://localhost:11434)
  --supervised         Enable HITL tools
  --hitl-auto          Auto-ack human prompts
  --headless           Run browser headless
  --config <path>      CLI yaml (default: config.yaml)
  --help               Show this help
Example:
  npm run desktop -- "Open google.com search openai, click first result" --yes --supervised --hitl-auto
`);
}

// ------------------ Defaults ------------------
const DEFAULTS = {
  model: 'qwen3-vl:4b',
  host: 'http://localhost:11434',
  supervised: false,
  hitlAuto: false,
  headless: false,
  browserPath: 'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe', // user-provided real Chrome
  userDataDir: '%LOCALAPPDATA%\\\\Google\\\\Chrome\\\\User Data', // base user data dir
  profileDir: 'Profile 1', // Chrome profile folder name for "Person 1"
  configPath: 'config.yaml',
  overallTimeoutMs: 480_000
};

// ------------------ Main ------------------
async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.help) return printHelp();

  const cliCfg = loadConfig(flags.config || DEFAULTS.configPath);
  const goal = positional.join(' ').trim();
  if (!goal) {
    console.error('Goal text is required.');
    process.exit(1);
  }

  const model = flags.model || cliCfg.model || DEFAULTS.model;
  const host = flags.host || cliCfg.host || DEFAULTS.host;
  const supervised = flags.supervised === true || cliCfg.supervised || DEFAULTS.supervised;
  const hitlAuto = flags['hitl-auto'] === true || cliCfg.hitlAuto || DEFAULTS.hitlAuto;
  const headless = flags.headless === true || cliCfg.headless || DEFAULTS.headless;
  const browserPath = process.env.BROWSER_USE_BROWSER_PATH || cliCfg.browserPath || DEFAULTS.browserPath;
  const userDataDir = process.env.BROWSER_USE_USER_DATA_DIR || cliCfg.userDataDir || DEFAULTS.userDataDir;
  const profileDir = process.env.BROWSER_USE_PROFILE_DIR || cliCfg.profileDir || DEFAULTS.profileDir;

  const runDir = path.join('artifacts', `run-${Date.now()}`);
  ensureDir(runDir);

const systemMessage = `
Be concise; follow ONLY the stated goal.
Loop: wait for load/idle → gather DOM & screenshot → clear popups/consent/captcha first (reject/close preferred) → act → verify via URL/element. Use vision (qwen3-vl) for blockers.
If on Google, prefer the tool google_search(query) to fill textarea/input name="q" and submit. Otherwise focus the box and press Enter. Do not click logos/images. Avoid the Sign in link unless goal requires it.
Treat auth/captcha as blockers; if stuck and supervised, call ask_human. If DOM empty, wait 2s then refresh once.
Outputs must be minimal valid JSON; keep free text under 40 words.
`.trim();

  const py = `
import os, asyncio, json, pathlib, time
from browser_use import Agent, Browser, Tools
from browser_use.llm import ChatOllama, ChatBrowserUse
from browser_use.tools.service import ActionResult
from browser_use.browser.session import BrowserSession

goal = ${JSON.stringify(goal)}
model = os.getenv("BROWSER_USE_MODEL") or "${model}"
base_url = "${host}".rstrip("/")
system_message = ${JSON.stringify(systemMessage)}
artifacts_dir = os.getenv("RUN_DIR") or "artifacts"
os.makedirs(artifacts_dir, exist_ok=True)
current_plan_step = 0

def _strip(v):
    if not v:
        return v
    v = v.strip()
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        return v[1:-1]
    return v

def _expand(v):
    return os.path.expandvars(v) if v else v

def _safe_json_from_text(txt):
    try:
        import json as pyjson, re
        m = re.search(r'\\{.*\\}', txt, re.S)
        if m:
            return pyjson.loads(m.group(0))
    except Exception:
        return None
    return None

def make_plan_md(goal_text):
    try:
        import requests, json as pyjson
        endpoint = base_url + "/v1/chat/completions"
        prompt = (
            "Return ONLY valid JSON with key 'steps'. "
            "Each step must have: 'title', 'action', 'success_criteria', 'fallback'. "
            "Keep it short and actionable. Goal: " + goal_text
        )
        payload = {
            "model": model,
            "messages": [{"role": "system", "content": prompt}],
            "stream": False,
        }
        r = requests.post(endpoint, json=payload, timeout=30)
        r.raise_for_status()
        data = r.json()
        content = None
        if "choices" in data and data["choices"]:
            content = data["choices"][0].get("message", {}).get("content", "")
        plan = _safe_json_from_text(content) if content else None
        steps = plan.get("steps") if isinstance(plan, dict) else None
        if not steps:
            raise RuntimeError("plan parse failed")
    except Exception:
        steps = [
            {
                "title": "Open target page",
                "action": "Navigate to the required URL or open the start page for the task.",
                "success_criteria": "Target page loaded; URL matches; main content visible.",
                "fallback": "Wait, refresh once, then retry navigation."
            },
            {
                "title": "Handle blockers",
                "action": "Detect and clear popups/consent/captcha that block interaction.",
                "success_criteria": "Main page elements are clickable; overlay gone.",
                "fallback": "Use reject/close; if blocked, ask_human (supervised)."
            },
            {
                "title": "Perform primary action",
                "action": "Execute the core action required by the goal (search, click, fill).",
                "success_criteria": "Expected page/state change or result is visible.",
                "fallback": "Retry once; use alternate selector or keypress."
            },
            {
                "title": "Verify result",
                "action": "Confirm the outcome and capture snapshot if requested.",
                "success_criteria": "Result matches goal; snapshot saved if required.",
                "fallback": "Re-evaluate last step and correct."
            },
        ]
    md = "# Task Plan\\n"
    for i, s in enumerate(steps, 1):
        md += f"\\n- [ ] Step {i}: {s['title']}\\n"
        md += f"  - Action: {s['action']}\\n"
        md += f"  - Success: {s['success_criteria']}\\n"
        md += f"  - Fallback: {s['fallback']}\\n"
    return md, steps

def normalize_plan(steps):
    # Merge blocker handling into the first step to avoid no-op blocker steps
    if not steps:
        return steps
    merged = []
    blocker = None
    for s in steps:
        title = (s.get("title") or "").lower()
        action = (s.get("action") or "").lower()
        if "blocker" in title or "popup" in action or "consent" in action or "captcha" in action:
            blocker = s
            continue
        merged.append(s)
    if blocker and merged:
        merged[0]["action"] = (merged[0].get("action","") + " Then clear blockers (popups/consent/captcha) before continuing.").strip()
        merged[0]["success_criteria"] = (merged[0].get("success_criteria","") + " No blocking overlays remain.").strip()
        merged[0]["fallback"] = (merged[0].get("fallback","") + " If blocked, close/deny or ask_human (supervised).").strip()
    return merged

browser_path = _expand(_strip(os.getenv("BROWSER_USE_BROWSER_PATH"))) or _expand(r"${browserPath.replace(/\\/g, '\\\\')}")
user_data_dir = _expand(_strip(os.getenv("BROWSER_USE_USER_DATA_DIR"))) or _expand("${userDataDir}")
profile_dir = _strip(os.getenv("BROWSER_USE_PROFILE_DIR")) or "${DEFAULTS.profileDir}"
browser = None

# LLM setup
if os.getenv("BROWSER_USE_API_KEY"):
    llm = ChatBrowserUse()
else:
    os.environ["OLLAMA_API_BASE"] = base_url + "/v1"
    llm = ChatOllama(model=model)

# Browser setup (see docs: customize/browser/all-parameters)
tools = Tools() if ${supervised ? 'True' : 'False'} else None

if tools:
    @tools.action(description='Ask a human to resolve a blocker (popup, captcha, form) and optionally describe what they did')
    async def ask_human(prompt: str = "Handle the blocking UI (popup/captcha) and type what you did.") -> ActionResult:
        import sys
        if ${hitlAuto ? 'True' : 'False'}:
            return ActionResult(extracted_content="[auto-ack HITL]", is_done=False)
        sys.stdout.write(f"[HITL] {prompt}\\n(type your note and press Enter)\\n> ")
        sys.stdout.flush()
        resp = sys.stdin.readline().strip()
        return ActionResult(extracted_content=resp or "ack")

    @tools.action(description='Click by screen coordinates to dismiss an overlay', allowed_domains=None)
    async def click_xy(x: float, y: float, browser_session: BrowserSession) -> ActionResult:
        await browser_session.click_point({"x": x, "y": y})
        return ActionResult(extracted_content=f"clicked {x},{y}")

    @tools.action(description='Fill Google search box with query and submit with Enter (uses JS for reliability)', allowed_domains=["*.google.*"])
    async def google_search(query: str, browser_session: BrowserSession) -> ActionResult:
        script = r"""
(() => {
  const box = document.querySelector('textarea[name="q"], input[name="q"]');
  if (!box) return 'no box';
  box.focus();
  box.value = arguments[0];
  box.dispatchEvent(new Event('input', {bubbles: true}));
  const form = box.form || document.querySelector('form[role="search"]');
  if (form) form.submit(); else {
    const enter = new KeyboardEvent('keydown', {key:'Enter', code:'Enter', which:13, keyCode:13, bubbles:true});
    box.dispatchEvent(enter);
  }
  return 'ok';
})();
"""
        res = await browser_session.evaluate(script, [query])
        return ActionResult(extracted_content=str(res))

def coord_from_interactable(interactables, idx):
    try:
        if not isinstance(interactables, (list, tuple)):
            return None
        for el in interactables:
            if isinstance(el, dict) and el.get("index") == idx:
                box = el.get("bounding_box") or {}
                cx = box.get("x", 0) + box.get("width", 0) / 2
                cy = box.get("y", 0) + box.get("height", 0) / 2
                if cx and cy:
                    return {"x": cx, "y": cy}
    except Exception:
        return None
    return None

async def vision_helper(state):
    try:
        screenshot = getattr(state, "screenshot", None)
        interactables = getattr(state, "interactables", None) or []
        if not screenshot:
            return None
        helper_model = os.getenv("BROWSER_USE_VISION_MODEL") or "${model}"
        endpoint = base_url + "/v1/chat/completions"
        prompt = "You see a browser screenshot and a list of interactive elements. If a blocking popup/consent/captcha is present, return JSON like {\\\"click_index\\\": number|null, \\\"reason\\\": \\\"...\\\"}. Prefer reject/decline/close/✕. If no blocker, return {\\\"click_index\\\": null, \\\"reason\\\": \\\"no blocker\\\"}."
        import requests
        payload = {
            "model": helper_model,
            "messages": [
                {"role": "system", "content": prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Interactables:\\n" + "\\n".join([str(i) for i in interactables])},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{screenshot}"}}
                    ]
                }
            ],
            "stream": False,
        }
        r = requests.post(endpoint, json=payload, timeout=20)
        r.raise_for_status()
        data = r.json()
        content = None
        if "choices" in data and data["choices"]:
            content = data["choices"][0].get("message", {}).get("content")
        if not content:
            return None
        import json as pyjson, re
        m = re.search(r'\\{.*\\}', content, re.S)
        if m:
            return pyjson.loads(m.group(0))
        return None
    except Exception as e:
        return {"error": str(e)}

async def on_step(state, output, idx):
    def save(name, obj):
        try:
            with open(pathlib.Path(artifacts_dir) / name, "w", encoding="utf-8") as f:
                json.dump(obj, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[debug] save {name} failed: {e}")

    def save_text(name, text):
        try:
            with open(pathlib.Path(artifacts_dir) / name, "w", encoding="utf-8") as f:
                f.write(text or "")
        except Exception as e:
            print(f"[debug] save {name} failed: {e}")

    prefix = f"plan-{current_plan_step}-step-{idx}"
    data = {
        "idx": idx,
        "url": getattr(state, "url", None),
        "title": getattr(state, "title", None),
        "text": getattr(state, "text", None),
        "interactables": getattr(state, "interactables", None),
        "model_output": output.model_dump() if hasattr(output, "model_dump") else str(output),
    }
    save(f"{prefix}-state.json", data)

    # Save screenshot if present
    try:
        screenshot = getattr(state, "screenshot", None)
        if screenshot:
            import base64
            img_bytes = base64.b64decode(screenshot)
            with open(pathlib.Path(artifacts_dir) / f"{prefix}-screenshot.png", "wb") as f:
                f.write(img_bytes)
    except Exception as e:
        print(f"[debug] screenshot save failed at step {idx}: {e}")

    # Compact interactables summary
    try:
        inter = getattr(state, "interactables", None) or []
        summary = []
        for el in inter:
            if isinstance(el, dict):
                summary.append({
                    "index": el.get("index"),
                    "type": el.get("type") or el.get("tag"),
                    "text": el.get("text"),
                    "role": el.get("role"),
                    "name": el.get("name"),
                    "aria_label": el.get("aria-label") or el.get("aria_label"),
                    "bounding_box": el.get("bounding_box"),
                })
        save(f"{prefix}-interactables.json", summary)
    except Exception as e:
        print(f"[debug] interactables summary failed at step {idx}: {e}")

    try:
        dom_state = getattr(state, "dom_state", None)
        if dom_state:
            dom_llm = dom_state.llm_representation(include_attributes=["id","name","aria-label","role","type","placeholder","href","alt"])
            dom_eval = dom_state.eval_representation(include_attributes=["id","name","aria-label","role","type","placeholder","href","alt"])
            save(f"{prefix}-dom.json", {
                "url": getattr(state, "url", None),
                "title": getattr(state, "title", None),
                "llm_representation": dom_llm,
                "eval_representation": dom_eval,
            })
            save(f"{prefix}-dom-metrics.json", {
                "llm_len": len(dom_llm or ""),
                "eval_len": len(dom_eval or ""),
                "interactables_count": len(getattr(state, "interactables", None) or []),
            })
    except Exception as e:
        print(f"[debug] dom dump failed at step {idx}: {e}")

    # Vision assist & auto-click
    suggestion = await vision_helper(state)
    if suggestion:
        save(f"step-{idx}-vision.json", suggestion)
        click_idx = suggestion.get("click_index") if isinstance(suggestion, dict) else None
        coord = coord_from_interactable(getattr(state, "interactables", None) or [], click_idx) if isinstance(click_idx, int) else None
        if coord and browser:
            try:
                await browser.click_point({"x": coord["x"], "y": coord["y"]})
                save(f"step-{idx}-vision-action.json", {"clicked": coord, "reason": suggestion.get("reason")})
                print(f"[vision] auto-clicked blocker at step {idx} using index {click_idx}")
            except Exception as e:
                save(f"step-{idx}-vision-action.json", {"error": str(e)})
                print(f"[vision] auto-click failed at step {idx}: {e}")

async def main():
    plan_md, plan_steps = make_plan_md(goal)
    plan_steps = normalize_plan(plan_steps)
    # rebuild plan_md to reflect normalized steps
    try:
        md = "# Task Plan\\n"
        for i, s in enumerate(plan_steps, 1):
            md += f"\\n- [ ] Step {i}: {s.get('title','') or 'Step'}\\n"
            md += f"  - Action: {s.get('action','')}\\n"
            md += f"  - Success: {s.get('success_criteria','')}\\n"
            md += f"  - Fallback: {s.get('fallback','')}\\n"
        plan_md = md
    except Exception:
        pass
    try:
        with open(pathlib.Path(artifacts_dir) / "plan.md", "w", encoding="utf-8") as f:
            f.write(plan_md)
        with open(pathlib.Path(artifacts_dir) / "plan.json", "w", encoding="utf-8") as f:
            json.dump(plan_steps, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[debug] failed to write plan: {e}")

    plan_instruction = "\\nPlan saved to plan.md. Follow steps in order, verify each step before continuing. Execute ONLY the current step; do not improvise or jump ahead.\\n"
    effective_system = system_message + plan_instruction

    # Track which plan step is running for logging
    global current_plan_step

    candidates = [
        {
            "label": "user-profile",
            "params": dict(
                executable_path=browser_path or None,
                user_data_dir=user_data_dir or None,
                profile_directory=profile_dir or None,
                keep_alive=True,
                headless=${headless ? 'True' : 'False'},
                args=["--remote-allow-origins=*","--disable-background-networking","--no-first-run"],
            ),
        },
        {
            "label": "temp-profile",
            "params": dict(
                executable_path=browser_path or None,
                user_data_dir=None,
                profile_directory=None,
                keep_alive=True,
                headless=${headless ? 'True' : 'False'},
                args=["--remote-allow-origins=*","--disable-background-networking","--no-first-run"],
            ),
        },
        {
            "label": "chromium-headless",
            "params": dict(
                executable_path=None,
                user_data_dir=None,
                profile_directory=None,
                keep_alive=True,
                headless=True,
                args=["--remote-allow-origins=*","--disable-background-networking","--no-first-run"],
            ),
        },
    ]

    last_error = None
    for cand in candidates:
        label = cand["label"]
        try:
            print(f"[runner] launching browser candidate: {label}")
            browser = Browser(**cand["params"])
            # Execute plan strictly: one step per Agent run
            for i, step in enumerate(plan_steps, 1):
                current_plan_step = i
                # Heuristic initial navigation for step 1
                initial_actions = None
                if i == 1:
                    url = None
                    import re
                    m = re.search(r'https?://\\S+', goal)
                    if m:
                        url = m.group(0).rstrip(').,;')
                    elif "google.com" in goal.lower():
                        url = "https://www.google.com"
                    if url:
                        initial_actions = [{"navigate": {"url": url}}]

                step_task = (
                    f"Step {i}: {step.get('title','')}. "
                    f"Action: {step.get('action','')}. "
                    f"Success: {step.get('success_criteria','')}. "
                    f"Fallback: {step.get('fallback','')}. "
                    "Execute ONLY this step and nothing else."
                )
                agent = Agent(
                    task=step_task,
                    browser=browser,
                    llm=llm,
                    directly_open_url=False,
                    max_failures=2,
                    max_actions_per_step=1,
                    use_thinking=False,
                    flash_mode=True,
                    llm_timeout=180,
                    step_timeout=150,
                    tools=tools,
                    save_conversation_path=${supervised ? 'f"{artifacts_dir}/conversation.jsonl"' : 'None'},
                    initial_actions=initial_actions,
                    extend_system_message=effective_system,
                    include_recent_events=True,
                    generate_gif=False,
                    file_system_path=artifacts_dir,
                    include_attributes=["id","name","aria-label","role","type","placeholder","href","alt"],
                    use_vision=True,
                    vision_detail_level="low",
                    register_new_step_callback=on_step,
                )
                history = await agent.run(max_steps=2)
                try:
                    names = history.action_names() if history else []
                    if not names:
                        print(f"[plan] step {i} produced no actions; stopping plan")
                        return
                except Exception:
                    pass
            try:
                actions_raw = history.action_history()
                def to_jsonable(x):
                    if hasattr(x, "model_dump"):
                        return x.model_dump()
                    if hasattr(x, "__dict__"):
                        return x.__dict__
                    return str(x)
                actions = [to_jsonable(a) for a in actions_raw] if actions_raw else []
                with open(pathlib.Path(artifacts_dir) / "history.json", "w", encoding="utf-8") as f:
                    json.dump(actions, f, ensure_ascii=False, indent=2)
                with open(pathlib.Path(artifacts_dir) / "history-urls.json", "w", encoding="utf-8") as f:
                    json.dump(history.urls(), f, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"[debug] failed to write history: {e}")
            return
        except Exception as e:
            last_error = e
            print(f"[runner] candidate {label} failed: {e}")
            continue

    raise last_error or RuntimeError("All browser candidates failed")

asyncio.run(main())
`;

  fs.writeFileSync(path.join(runDir, 'agent.py'), py, 'utf8');

  const env = {
    ...process.env,
    RUN_DIR: runDir,
    BROWSER_USE_BROWSER_PATH: browserPath,
    BROWSER_USE_USER_DATA_DIR: userDataDir,
    BROWSER_USE_MODEL: model,
    BROWSER_USE_BASE_URL: host,
    OLLAMA_API_BASE: `${host.replace(/\/$/, '')}/v1`,
    NO_PROXY: process.env.NO_PROXY || '127.0.0.1,localhost',
  };

  await new Promise((resolve) => {
    const child = spawn('python', ['-c', py], { stdio: 'inherit', env });
    const timer = setTimeout(() => {
      console.warn('browser-use run exceeded 240s, sending SIGTERM');
      child.kill('SIGTERM');
      setTimeout(() => !child.killed && child.kill('SIGKILL'), 2000);
    }, DEFAULTS.overallTimeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

main().catch((err) => {
  console.error('Fatal error', err);
  process.exit(1);
});
