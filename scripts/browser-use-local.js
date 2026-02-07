#!/usr/bin/env node
/**
 * Run browser_use locally with Ollama as LLM.
 * Requires: Python + browser-use installed (`pip install browser-use`) and Ollama running.
 *
 * Usage:
 *   TASK="Open example.com and screenshot" npm run browser-use:local
 *   or: node scripts/browser-use-local.js "Open example.com and screenshot"
 *
 * Optional env:
 *   BROWSER_USE_MODEL (default: ollama/llama3)
 *   OLLAMA_URL (default: http://localhost:11434)
 */
import { spawnSync } from 'child_process';

const goal =
  process.argv.slice(2).join(' ').trim() ||
  process.env.BROWSER_USE_TASK ||
  process.env.TASK;

if (!goal) {
  console.error('Set TASK or BROWSER_USE_TASK, or pass the goal as an argument.');
  process.exit(1);
}

const model = process.env.BROWSER_USE_MODEL || 'ollama/qwen3-vl:4b';
const llmBase = `${(process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '')}/v1`;

const args = [
  '-m',
  'browser_use',
  'run',
  '--model',
  model,
  '--llm-base-url',
  llmBase,
  '--task',
  goal
];

console.log(`Running browser_use with model=${model} llm-base=${llmBase}`);
const res = spawnSync('python', args, { stdio: 'inherit', env: process.env });
if (res.status !== 0) {
  console.error('browser_use failed. Ensure Python and browser-use are installed: pip install browser-use');
  process.exit(res.status || 1);
}
