#!/usr/bin/env node
import { Command } from 'commander';
import { initDb, listAgents, insertTask, listTasks, listReviewableRuns, getTask as getTaskDb, getAgent as getAgentDb, type Task } from '../server/db.js';
import { loadConfig } from '../server/config.js';
import * as sessionManager from '../server/session-manager.js';
import * as outputWatcher from '../server/output-watcher.js';
import * as taskDispatcher from '../server/task-dispatcher.js';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getServerEntryUrl, resolveAppRoot, resolveServerEntry } from './server-entry.js';

const APP_ROOT = resolveAppRoot(import.meta.dirname);
process.chdir(APP_ROOT);

const PID_FILE = path.join(APP_ROOT, '.wavecode.pid');
const CONFIG_FILE = path.join(APP_ROOT, 'config.yaml');

const program = new Command();
program
  .name('wavecode')
  .description('Autonomous multi-agent CLI orchestration platform')
  .version('0.1.0');

function loadInstalledConfig(): void {
  loadConfig(CONFIG_FILE);
}

// --- scan ---
program
  .command('scan')
  .description('List all tmux sessions on this server')
  .action(() => {
    initDb();
    loadInstalledConfig();
    const result = sessionManager.scan();
    if (!result.ok) {
      console.error('Error:', result.error);
      process.exit(1);
    }

    const agents = listAgents();
    const adoptedSessions = new Set(agents.map((a) => a.tmux_session));

    if (result.data.length === 0) {
      console.log('No tmux sessions found.');
      return;
    }

    console.log(`Found ${result.data.length} tmux session(s):\n`);
    for (const s of result.data) {
      const age = formatDuration(Date.now() / 1000 - s.created);
      const adopted = adoptedSessions.has(s.name) ? ' (adopted)' : '';
      console.log(`  ${s.name}  (running ${age})${adopted}`);
    }
  });

// --- adopt ---
program
  .command('adopt <session>')
  .description('Monitor an existing tmux session')
  .requiredOption('--runtime <type>', 'Agent runtime: claude-code, codex, aider')
  .option('--name <name>', 'Custom agent name')
  .action((session, opts) => {
    initDb();
    loadInstalledConfig();
    const result = sessionManager.adopt(session, opts.runtime, opts.name);
    if (!result.ok) {
      console.error('Error:', result.error);
      process.exit(1);
    }
    console.log(`✓ Adopted. Agent '${result.data.name}' monitoring via capture-pane.`);
  });

// --- status ---
program
  .command('status')
  .description('Show all agents summary')
  .action(() => {
    initDb();
    loadInstalledConfig();
    const agents = listAgents();

    if (agents.length === 0) {
      console.log('No agents managed. Use `wavecode scan` and `wavecode adopt` to get started.');
      return;
    }

    console.log(`\n  ${'NAME'.padEnd(20)} ${'RUNTIME'.padEnd(14)} ${'MODE'.padEnd(10)} ${'STATUS'.padEnd(10)} SESSION`);
    console.log('  ' + '-'.repeat(74));
    for (const a of agents) {
      const status = a.status === 'working' ? '● working' : a.status === 'error' ? '✗ error' : '○ idle';
      console.log(`  ${a.name.padEnd(20)} ${a.runtime.padEnd(14)} ${a.mode.padEnd(10)} ${status.padEnd(10)} ${a.tmux_session}`);
    }
    console.log('');
  });

// --- agents ---
program
  .command('agents')
  .description('List agents with details')
  .action(() => {
    initDb();
    loadInstalledConfig();
    const agents = listAgents();

    if (agents.length === 0) {
      console.log('No agents managed.');
      return;
    }

    for (const a of agents) {
      console.log(`\n  ${a.name}`);
      console.log(`    ID:       ${a.id}`);
      console.log(`    Runtime:  ${a.runtime}`);
      console.log(`    Mode:     ${a.mode}`);
      console.log(`    Status:   ${a.status}`);
      console.log(`    Session:  ${a.tmux_session}`);
      if (a.workspace) console.log(`    Workspace: ${a.workspace}`);
      console.log(`    Created:  ${a.created_at}`);
    }
    console.log('');
  });

// --- send ---
program
  .command('send <agent> <prompt>')
  .description('Send a prompt to an agent via tmux send-keys')
  .action((agent, prompt) => {
    initDb();
    loadInstalledConfig();

    const agentResult = sessionManager.get(agent);
    if (!agentResult.ok) {
      console.error('Error:', agentResult.error);
      process.exit(1);
    }

    const result = sessionManager.sendKeys(agentResult.data.id, prompt);
    if (!result.ok) {
      console.error('Error:', result.error);
      process.exit(1);
    }
    console.log(`✓ Sent to '${agentResult.data.name}'.`);
  });

// --- logs ---
program
  .command('logs <agent>')
  .description('Tail captured output from an agent')
  .option('-n, --lines <n>', 'Number of lines', '50')
  .action((agent, opts) => {
    initDb();
    loadInstalledConfig();

    const agentResult = sessionManager.get(agent);
    if (!agentResult.ok) {
      console.error('Error:', agentResult.error);
      process.exit(1);
    }

    const result = sessionManager.capturePane(agentResult.data.tmux_session, parseInt(opts.lines, 10));
    if (!result.ok) {
      console.error('Error:', result.error);
      process.exit(1);
    }
    console.log(result.data);
  });

// --- spawn ---
program
  .command('spawn')
  .description('Create a new agent with runner wrapper')
  .requiredOption('--name <name>', 'Agent name')
  .requiredOption('--runtime <type>', 'Agent runtime: claude-code, codex, aider')
  .option('--repo <path>', 'Repository path (creates git worktree)')
  .option('--branch <name>', 'Branch name for worktree')
  .action((opts) => {
    initDb();
    loadInstalledConfig();

    const result = sessionManager.spawnAgent({
      name: opts.name,
      runtime: opts.runtime,
      repo: opts.repo,
      branch: opts.branch,
    });

    if (!result.ok) {
      console.error('Error:', result.error);
      process.exit(1);
    }

    const agent = result.data;
    console.log(`✓ Using workspace: ${agent.workspace ?? 'N/A'}`);
    console.log(`✓ Started tmux session: ${agent.tmux_session}`);
    console.log(`✓ Runner wrapper active. Emitting events.`);
  });

// --- queue ---
program
  .command('queue <prompt>')
  .description('Add a task to the queue')
  .option('--agent <name>', 'Assign to specific agent')
  .option('--priority <n>', 'Priority (higher = first)', '0')
  .option('--depends-on <ids>', 'Comma-separated task IDs this depends on')
  .action((prompt, opts) => {
    initDb();
    loadInstalledConfig();

    let agentId: string | undefined;
    if (opts.agent) {
      const agentResult = sessionManager.get(opts.agent);
      if (!agentResult.ok) {
        console.error('Error:', agentResult.error);
        process.exit(1);
      }
      agentId = agentResult.data.id;
    }

    const result = insertTask({
      prompt,
      agent_id: agentId,
      priority: parseInt(opts.priority, 10),
    });

    if (!result.ok) {
      console.error('Error:', result.error);
      process.exit(1);
    }

    // Add dependencies
    if (opts.dependsOn) {
      const depIds = opts.dependsOn.split(',').map((s: string) => s.trim());
      for (const depId of depIds) {
        taskDispatcher.addDependency(result.data.id, depId);
      }
    }

    console.log(`✓ Task queued: ${result.data.id}`);
    if (agentId) console.log(`  Assigned to: ${opts.agent}`);
    if (opts.dependsOn) console.log(`  Depends on: ${opts.dependsOn}`);
  });

// --- tasks ---
program
  .command('tasks')
  .description('List tasks')
  .option('--agent <name>', 'Filter by agent')
  .option('--status <status>', 'Filter by status')
  .action((opts) => {
    initDb();
    loadInstalledConfig();

    let agentId: string | undefined;
    if (opts.agent) {
      const agentResult = sessionManager.get(opts.agent);
      if (!agentResult.ok) {
        console.error('Error:', agentResult.error);
        process.exit(1);
      }
      agentId = agentResult.data.id;
    }

    const tasks = listTasks({ agent_id: agentId, status: opts.status });

    if (tasks.length === 0) {
      console.log('No tasks found.');
      return;
    }

    const STATUS_ICONS: Record<string, string> = {
      pending: '○',
      running: '●',
      done: '✓',
      failed: '✗',
      blocked: '⊘',
    };

    console.log(`\n  ${'ID'.padEnd(28)} ${'STATUS'.padEnd(10)} ${'PRI'.padEnd(5)} PROMPT`);
    console.log('  ' + '-'.repeat(80));
    for (const t of tasks) {
      const icon = STATUS_ICONS[t.status] ?? '?';
      const promptPreview = t.prompt.substring(0, 40) + (t.prompt.length > 40 ? '...' : '');
      console.log(`  ${t.id.padEnd(28)} ${(icon + ' ' + t.status).padEnd(10)} ${String(t.priority).padEnd(5)} ${promptPreview}`);
    }
    console.log('');
  });

// --- upgrade ---
program
  .command('upgrade <agent>')
  .description('Upgrade an adopted agent to spawned mode')
  .option('--repo <path>', 'Repository path for worktree')
  .action((agent, opts) => {
    initDb();
    loadInstalledConfig();

    const agentResult = sessionManager.get(agent);
    if (!agentResult.ok) {
      console.error('Error:', agentResult.error);
      process.exit(1);
    }

    const result = sessionManager.upgrade(agentResult.data.id, opts.repo);
    if (!result.ok) {
      console.error('Error:', result.error);
      process.exit(1);
    }

    const upgraded = result.data;
    console.log(`✓ Detached from tmux session ${agentResult.data.tmux_session}`);
    if (upgraded.workspace) console.log(`✓ Using workspace: ${upgraded.workspace}`);
    console.log(`✓ Started new session ${upgraded.tmux_session} with runner wrapper`);
    console.log(`✓ Mode changed: adopted → spawned`);
  });

// --- review ---
program
  .command('review')
  .description('Show pending review queue')
  .action(() => {
    initDb();
    loadInstalledConfig();

    const runs = listReviewableRuns();

    if (runs.length === 0) {
      console.log('Review queue is clear. No runs pending review.');
      return;
    }

    console.log(`\n  ${runs.length} run(s) pending review:\n`);
    for (const run of runs) {
      const task = getTaskDb(run.task_id);
      const agent = getAgentDb(run.agent_id);
      const taskPrompt = task.ok ? task.data.prompt.substring(0, 50) : 'unknown';
      const agentName = agent.ok ? agent.data.name : 'unknown';
      const duration = run.finished_at
        ? Math.floor((new Date(run.finished_at + 'Z').getTime() - new Date(run.started_at + 'Z').getTime()) / 1000)
        : null;

      console.log(`  ${run.id}`);
      console.log(`    Task:     ${taskPrompt}${task.ok && task.data.prompt.length > 50 ? '...' : ''}`);
      console.log(`    Agent:    ${agentName}`);
      console.log(`    Attempt:  #${run.attempt}`);
      console.log(`    Duration: ${duration ? `${duration}s` : 'N/A'}`);
      console.log(`    Status:   ${run.review_status}`);
      console.log('');
    }
  });

// --- server start ---
const serverCmd = program
  .command('server')
  .description('Manage the WaveCode daemon');

serverCmd
  .command('start')
  .description('Start the WaveCode daemon')
  .option('-f, --foreground', 'Run in foreground')
  .action((opts) => {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
      try {
        process.kill(pid, 0);
        console.log(`WaveCode is already running (PID ${pid}).`);
        return;
      } catch {
        // Stale PID file
        fs.unlinkSync(PID_FILE);
      }
    }

    const serverEntry = resolveServerEntry(import.meta.dirname);

    if (opts.foreground) {
      console.log('Starting WaveCode in foreground...');
      import(getServerEntryUrl(import.meta.dirname));
      return;
    }

    const child: ChildProcess = fork(serverEntry.path, [], {
      detached: true,
      stdio: 'ignore',
      execArgv: serverEntry.execArgv,
    });

    if (child.pid) {
      fs.writeFileSync(PID_FILE, String(child.pid));
      child.unref();
      console.log(`✓ WaveCode daemon started (PID ${child.pid}).`);
    }
  });

serverCmd
  .command('stop')
  .description('Stop the WaveCode daemon')
  .action(() => {
    if (!fs.existsSync(PID_FILE)) {
      console.log('WaveCode is not running.');
      return;
    }

    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 'SIGTERM');
      fs.unlinkSync(PID_FILE);
      console.log(`✓ WaveCode stopped (PID ${pid}).`);
    } catch {
      fs.unlinkSync(PID_FILE);
      console.log('WaveCode was not running (stale PID file removed).');
    }
  });

program.parse();

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
