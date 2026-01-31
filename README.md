# Loopert (agentic browser POC)

Desktop-first agentic browser runner with structured planning, guardrails, and UI-grounded actions.

## Quick start
```bash
npm install
npm run desktop -- "Navigate to https://example.com and snapshot" --yes --profile default
```
- Use `--profile auto` or `--profile unleashed` to enable coordinate + high-power tools (shell/write_file).
- Set `--stub-plan` to run against the built-in test page.

## Planner highlights
- Schema: `reasoning_summary`, `plan_id`, `autonomy_level`, `steps[{tool,args,explanation,estimated_risk,confidence}]`.
- Modes: prompt templates for desktop (`computer`), mobile (`mobile`), grounding (`grounding`); picked automatically by profile or `prompt_variant`.
- Tools (subset): navigate, click, type, scroll, wait_for_idle, snapshot, click_point, drag, long_press, hotkey, fetch, read_file, write_file, shell (profile-gated).
- Context: planner gets page URL/title/origin, interactables list, viewport, and optional screenshot (base64).

## Guardrails & profiles
- `default`: conservative, blocks shell/write_file, origin confirmations required.
- `pro`: higher step budget, still blocks shell/write_file.
- `auto`: high autonomy, allows shell/write_file, origin prompts off.
- `unleashed`: max power (40 steps, high-risk tools allowed). Configure in `guardrails.yaml`.

## CI
GitHub Actions workflow runs `npm ci` + `npm test` (smoke imports core/llm).

## Issue opener workflow
`workflow_dispatch` workflow uses `gh issue create` with `secrets.GITHUB_TOKEN` to file an issue on demand.

## Ralph-style loop runner
- Configure tasks in `tasks/ralph.json` (see `tasks/ralph.json.example`).
- Run: `npm run ralph` (auto-approves plans, headless, up to 5 iterations by default).
- Results are appended to `progress.txt`; task pass/fail is persisted back to the tasks file.

### Upstream Ralph assets
If you want the original Ralph prompt/harness from snarktank/ralph:
- Fetch: `npm run ralph:fetch` (downloads `ralph.sh` and `prompt.md` into `scripts/ralph-upstream/`).
- Then run upstream script (requires bash): `bash scripts/ralph-upstream/ralph.sh` (adjust per your environment).

## Agent‑TARS + Ollama helper
- Pull UI‑TARS 7B model to Ollama: `npm run ollama:pull-tars`
- Run Agent‑TARS CLI against the Ollama OpenAI endpoint:  
  `npm run agent-tars:ollama`
  (uses provider=openai, apiBase=http://localhost:11434/v1, dummy apiKey, model=ui-tars-1.5-7b)
Make sure `ollama serve` is running and Node ≥22 for the Agent‑TARS CLI.

## Browser-Use (optional)
Prefer local usage (PyPI) with Ollama for LLM. Cloud runner removed by default; if you need cloud, add your own script later.
