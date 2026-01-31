#!/usr/bin/env node
/**
 * Minimal Ralph-style loop for Loopert.
 * Reads tasks from a JSON file, runs the desktop agent once per task with fresh context,
 * marks successes, appends learnings to progress.txt, and repeats until done or limits hit.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const ix = args.indexOf(`--${name}`);
  if (ix === -1) return fallback;
  const val = args[ix + 1];
  return val && !val.startsWith('--') ? val : true;
}

const tasksPath = flag('tasks', 'tasks/ralph.json');
const maxIterations = Number(flag('max', 10));
const headless = flag('headless', true) !== 'false';
const autoApprove = true;
const disableTestSite = flag('disable-test-site', true) !== 'false';
const promptVariant = flag('prompt-variant', null);

function loadTasks(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Tasks file not found: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveTasks(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function logProgress(msg) {
  fs.appendFileSync('progress.txt', `${new Date().toISOString()} ${msg}\n`);
}

function runGoal(goal) {
  const cmdArgs = [
    'apps/desktop/index.js',
    goal,
    '--yes',
    '--headless',
    `--disable-test-site=${disableTestSite}`,
    promptVariant ? `--prompt-variant=${promptVariant}` : null
  ].filter(Boolean);

  const res = spawnSync('node', cmdArgs, { stdio: 'inherit' });
  return res.status === 0;
}

function nextTask(tasks) {
  return tasks.userStories?.find((t) => t.passes === false || t.passes === undefined);
}

function main() {
  let tasks = loadTasks(tasksPath);
  let iteration = 0;
  while (iteration < maxIterations) {
    const task = nextTask(tasks);
    if (!task) {
      console.log('All tasks complete.');
      return;
    }
    iteration += 1;
    console.log(`\n[ralph] Iteration ${iteration}/${maxIterations} -> ${task.id || task.title}`);
    const goal = task.goal || task.title || `Complete task ${task.id}`;
    const ok = runGoal(goal);
    if (ok) {
      task.passes = true;
      logProgress(`PASS ${task.id || task.title}`);
    } else {
      task.passes = false;
      logProgress(`FAIL ${task.id || task.title}`);
    }
    saveTasks(tasksPath, tasks);
  }
  console.log('Max iterations reached.');
}

main();
