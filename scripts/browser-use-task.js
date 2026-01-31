#!/usr/bin/env node
/**
 * Minimal Browser-Use Cloud runner.
 * Requires: npm install browser-use-sdk, env BROWSER_USE_API_KEY
 * Usage: TASK="your goal" npm run browser-use:cloud
 */
import { BrowserUseClient } from 'browser-use-sdk';

async function main() {
  const goal = process.argv.slice(2).join(' ').trim() || process.env.TASK;
  if (!goal) {
    console.error('Usage: TASK="your goal" npm run browser-use:cloud');
    process.exit(1);
  }
  const apiKey = process.env.BROWSER_USE_API_KEY;
  if (!apiKey) {
    console.error('Set BROWSER_USE_API_KEY');
    process.exit(1);
  }

  const client = new BrowserUseClient({ apiKey });

  const task = await client.tasks.createTask({
    task: goal,
    llm: process.env.BROWSER_USE_MODEL || 'gpt-4o'
  });

  console.log(`Task created: ${task.id}`);

  for await (const event of task.stream()) {
    if (event.type === 'step_completed') {
      console.log(`Step: ${event.step?.description || ''} (${event.step?.status || ''})`);
    } else if (event.type === 'task_completed') {
      console.log('Task completed');
    } else {
      console.log(event.type);
    }
  }

  const result = await task.complete();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('browser-use task failed', err);
  process.exit(1);
});
