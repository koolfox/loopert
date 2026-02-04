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
Be concise; follow the stated goal only.
Loop: wait for load/idle → gather DOM & screenshot → clear popups/consent/captcha first (reject/close preferred) → act → verify via URL/element.
Use vision (qwen3-vl) to locate blockers; click close/reject/✕ or consent if reject missing.
Google search: focus textarea[name="q"] or input[name="q"], type query, press Enter; do not click logos/images.
Treat auth/captcha as blockers unless goal explicitly requires login; if blocked and supervised, call ask_human.
If DOM empty, wait 2s then refresh once.
Outputs must be minimal JSON; keep text under 40 words.
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

def _strip(v):
    if not v:
        return v
    v = v.strip()
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        return v[1:-1]
    return v

def _expand(v):
    return os.path.expandvars(v) if v else v

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

    data = {
        "idx": idx,
        "url": getattr(state, "url", None),
        "title": getattr(state, "title", None),
        "text": getattr(state, "text", None),
        "interactables": getattr(state, "interactables", None),
        "model_output": output.model_dump() if hasattr(output, "model_dump") else str(output),
    }
    save(f"step-{idx}-state.json", data)

    try:
        dom_state = getattr(state, "dom_state", None)
        if dom_state:
            dom_llm = dom_state.llm_representation(include_attributes=["id","name","aria-label","role","type","placeholder","href","alt"])
            dom_eval = dom_state.eval_representation(include_attributes=["id","name","aria-label","role","type","placeholder","href","alt"])
            save(f"step-{idx}-dom.json", {
                "url": getattr(state, "url", None),
                "title": getattr(state, "title", None),
                "llm_representation": dom_llm,
                "eval_representation": dom_eval,
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
    candidates = [
        {
            "label": "user-profile",
            "params": dict(
                executable_path=browser_path or None,
                user_data_dir=user_data_dir or None,
                profile_directory=profile_dir or None,
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
            agent = Agent(
                task=goal,
                browser=browser,
                llm=llm,
                directly_open_url=False,
                max_failures=2,
                max_actions_per_step=2,
                use_thinking=False,
                flash_mode=True,
                llm_timeout=120,
                step_timeout=180,
                tools=tools,
                save_conversation_path=${supervised ? 'f"{artifacts_dir}/conversation.jsonl"' : 'None'},
                initial_actions=None,
                extend_system_message=system_message,
                include_recent_events=True,
                generate_gif=False,
                file_system_path=artifacts_dir,
                include_attributes=["id","name","aria-label","role","type","placeholder","href","alt"],
                use_vision=True,
                vision_detail_level="low",
                register_new_step_callback=on_step,
            )
            history = await agent.run()
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
