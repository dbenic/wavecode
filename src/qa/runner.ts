/**
 * QA agent runner — the core loop.
 *
 *   load scenario + persona
 *      ↓
 *   launch browser at starting_url
 *      ↓
 *   loop:
 *     screenshot
 *     ask LLM for next action  (with last screenshot + console errors)
 *     execute action via Playwright
 *     append tool_result to conversation
 *   until LLM calls `complete` or max_steps reached
 *      ↓
 *   write report.md + findings.json + screenshots/* to session dir
 *
 * Cost discipline: only the LATEST screenshot is kept in the message history
 * as an image. All older screenshots are referenced by step number in text.
 * This keeps a 25-step session under ~80K input tokens.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { ulid } from 'ulid';
import { launchBrowser, type BrowserSession, type ConsoleEvent } from './browser.js';
import { buildSystemPrompt, callLlm, estimateCost } from './llm.js';
import type { Finding, Persona, RunResult, Scenario } from './types.js';
import { WaveCodeClient, buildDocUrl } from './wavecode-client.js';

interface RunOptions {
  scenarioPath: string;
  personaPath: string;
  targetUrlOverride?: string;
  apiKey: string;
  model?: string;
  outputDir: string;
  headless?: boolean;
  maxSteps?: number;
  log?: (msg: string) => void;
  /**
   * If set, the QA report is also POSTed to this WaveCode instance and
   * attached to the named agent so it appears under that agent's docs.
   */
  attachToAgent?: {
    waveCodeUrl: string;
    waveCodeToken?: string;
    agentIdOrName: string;
  };
}

export async function runScenario(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? ((m) => console.log(m));

  const scenario = loadYaml<Scenario>(opts.scenarioPath);
  const persona = loadYaml<Persona>(opts.personaPath);

  if (opts.targetUrlOverride) scenario.starting_url = opts.targetUrlOverride;
  const maxSteps = opts.maxSteps ?? scenario.max_steps ?? 25;

  const sessionId = ulid();
  const sessionDir = path.join(opts.outputDir, `${scenario.id}-${persona.id}-${sessionId}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  log(`▸ Scenario: ${scenario.title}`);
  log(`▸ Persona: ${persona.name}`);
  log(`▸ Starting URL: ${scenario.starting_url}`);
  log(`▸ Session dir: ${sessionDir}`);
  log('');

  const browser = await launchBrowser({
    startingUrl: scenario.starting_url,
    sessionDir,
    headless: opts.headless ?? true,
  });

  const startTs = Date.now();
  const findings: Finding[] = [];
  const messages: Anthropic.Messages.MessageParam[] = [];
  const stepLog: string[] = [];
  let outcome: RunResult['outcome'] = 'max_steps_reached';
  let notes: string | undefined;
  let totalCost = 0;
  let step = 0;

  try {
    const system = buildSystemPrompt(persona, scenario);

    while (step < maxSteps) {
      step++;
      const shot = await browser.screenshot(`step-${String(step).padStart(3, '0')}`);
      const consoleEvents = browser.drainConsoleEvents();

      // Build the user message: replace any prior image content with text refs,
      // attach only the latest screenshot.
      pruneOldImages(messages);

      const consoleSummary =
        consoleEvents.length > 0
          ? `Console events since last action:\n${consoleEvents.map(formatConsoleEvent).join('\n')}`
          : 'No new console events.';

      messages.push({
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: shot.bytes.toString('base64'),
            },
          },
          {
            type: 'text',
            text: `Step ${step} — current URL: ${browser.page.url()}\n\n${consoleSummary}\n\nWhat is your next action? Use the tools — including \`record_finding\` for any observation worth reporting, and \`complete\` when you are done.`,
          },
        ],
      });

      log(`  step ${step}: → calling LLM`);
      const response = await callLlm({
        apiKey: opts.apiKey,
        model: opts.model ?? 'claude-sonnet-4-5-20250929',
        system,
        messages,
      });
      totalCost += estimateCost(response.usage);

      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      );

      if (toolUses.length === 0) {
        log('  ⚠ LLM produced no tool calls — ending session');
        outcome = 'blocked';
        notes = 'LLM stopped using tools';
        break;
      }

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      let completed = false;

      for (const toolUse of toolUses) {
        const result = await executeTool(toolUse, browser, findings, step, shot.path);
        stepLog.push(`Step ${step} :: ${toolUse.name}(${JSON.stringify(toolUse.input)}) → ${result.summary}`);
        log(`  ↳ ${toolUse.name}: ${result.summary}`);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.summary,
          is_error: result.isError ?? false,
        });

        if (toolUse.name === 'complete') {
          const input = toolUse.input as { outcome: RunResult['outcome']; notes?: string };
          outcome = input.outcome;
          notes = input.notes;
          completed = true;
        }
      }

      messages.push({ role: 'user', content: toolResults });
      if (completed) break;
    }
  } finally {
    await browser.close();
  }

  const result: RunResult = {
    scenario_id: scenario.id,
    persona_id: persona.id,
    starting_url: scenario.starting_url,
    outcome,
    findings,
    step_count: step,
    duration_seconds: Math.round((Date.now() - startTs) / 1000),
    notes,
    session_dir: sessionDir,
  };

  await writeReport(sessionDir, result, scenario, persona, stepLog, totalCost);
  log('');
  log(`✓ Session complete: ${outcome}`);
  log(`  Findings: ${findings.length} (bugs:${count(findings, 'bug')} ux:${count(findings, 'ux_issue')} q:${count(findings, 'question')} sugg:${count(findings, 'suggestion')})`);
  log(`  Steps: ${step}, Duration: ${result.duration_seconds}s, Estimated cost: $${totalCost.toFixed(3)}`);
  log(`  Report: ${path.join(sessionDir, 'report.md')}`);

  if (opts.attachToAgent) {
    try {
      const reportPath = path.join(sessionDir, 'report.md');
      const reportContent = fs.readFileSync(reportPath, 'utf-8');
      const filename = `qa-${scenario.id}-${persona.id}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`;

      const client = new WaveCodeClient({
        baseUrl: opts.attachToAgent.waveCodeUrl,
        token: opts.attachToAgent.waveCodeToken,
      });

      const agent = await client.findAgent(opts.attachToAgent.agentIdOrName);
      if (!agent) {
        log(`  ⚠ Agent "${opts.attachToAgent.agentIdOrName}" not found — skipping doc attach`);
      } else if (!agent.workspace) {
        log(`  ⚠ Agent "${agent.name}" has no workspace — cannot attach doc`);
      } else {
        const result = await client.writeAgentDoc({
          agentId: agent.id,
          filename,
          content: reportContent,
          subdir: 'qa-reports',
        });
        const url = buildDocUrl(opts.attachToAgent.waveCodeUrl, result.slug);
        log('');
        log(`  ✓ Attached to agent "${agent.name}" (${agent.id})`);
        log(`    Doc URL: ${url}`);
        log(`    Workspace path: ${result.path}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`  ⚠ Failed to attach doc: ${msg}`);
    }
  }

  return result;
}

// ---------- helpers ----------

interface ToolExecutionResult {
  summary: string;
  isError?: boolean;
}

async function executeTool(
  toolUse: Anthropic.Messages.ToolUseBlock,
  browser: BrowserSession,
  findings: Finding[],
  step: number,
  screenshotPath: string,
): Promise<ToolExecutionResult> {
  const input = toolUse.input as Record<string, unknown>;
  try {
    switch (toolUse.name) {
      case 'click': {
        await browser.click(
          String(input.selector),
          (input.by as 'css' | 'text' | 'role') ?? 'css',
        );
        return { summary: `clicked ${input.selector}` };
      }
      case 'type': {
        await browser.type(
          String(input.selector),
          String(input.value),
          (input.by as 'css' | 'placeholder' | 'label') ?? 'css',
        );
        return { summary: `typed into ${input.selector}` };
      }
      case 'press_key': {
        await browser.pressKey(String(input.key));
        return { summary: `pressed ${input.key}` };
      }
      case 'navigate': {
        await browser.navigate(String(input.url));
        return { summary: `navigated to ${input.url}` };
      }
      case 'scroll': {
        await browser.scroll(
          (input.direction as 'up' | 'down') ?? 'down',
          (input.amount as number) ?? 500,
        );
        return { summary: `scrolled ${input.direction}` };
      }
      case 'wait': {
        await browser.wait((input.seconds as number) ?? 1);
        return { summary: `waited ${input.seconds}s` };
      }
      case 'record_finding': {
        const finding: Finding = {
          severity: input.severity as Finding['severity'],
          summary: String(input.summary),
          evidence: String(input.evidence),
          why_it_matters: String(input.why_it_matters),
          suggested_fix: input.suggested_fix ? String(input.suggested_fix) : undefined,
          step,
          screenshot_ref: path.basename(screenshotPath),
        };
        findings.push(finding);
        return { summary: `recorded ${finding.severity}: ${finding.summary}` };
      }
      case 'complete': {
        return { summary: `complete: ${input.outcome}` };
      }
      default:
        return { summary: `unknown tool: ${toolUse.name}`, isError: true };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { summary: `ERROR executing ${toolUse.name}: ${msg}`, isError: true };
  }
}

/**
 * Strip image content from earlier user messages, replacing each with a
 * short text reference. Keeps token use bounded across long sessions.
 */
function pruneOldImages(messages: Anthropic.Messages.MessageParam[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    const hasImage = m.content.some((b) => typeof b === 'object' && b !== null && 'type' in b && b.type === 'image');
    if (!hasImage) continue;
    m.content = m.content
      .filter((b) => !(typeof b === 'object' && b !== null && 'type' in b && b.type === 'image'))
      .map((b) =>
        typeof b === 'object' && b !== null && 'type' in b && b.type === 'text'
          ? { type: 'text', text: `[earlier screenshot omitted to save tokens] ${b.text.split('\n')[0]}` }
          : b,
      ) as typeof m.content;
  }
}

function loadYaml<T>(p: string): T {
  if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);
  return yaml.load(fs.readFileSync(p, 'utf-8')) as T;
}

function formatConsoleEvent(e: ConsoleEvent): string {
  return `  [${e.type}] ${e.text}`;
}

function count(findings: Finding[], severity: Finding['severity']): number {
  return findings.filter((f) => f.severity === severity).length;
}

async function writeReport(
  sessionDir: string,
  result: RunResult,
  scenario: Scenario,
  persona: Persona,
  stepLog: string[],
  totalCost: number,
): Promise<void> {
  fs.writeFileSync(
    path.join(sessionDir, 'findings.json'),
    JSON.stringify(result, null, 2),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(sessionDir, 'steps.log'),
    stepLog.join('\n'),
    'utf-8',
  );

  const md = renderMarkdownReport(result, scenario, persona, totalCost);
  fs.writeFileSync(path.join(sessionDir, 'report.md'), md, 'utf-8');
}

function renderMarkdownReport(
  result: RunResult,
  scenario: Scenario,
  persona: Persona,
  totalCost: number,
): string {
  const groups: Record<Finding['severity'], Finding[]> = {
    bug: [],
    ux_issue: [],
    question: [],
    suggestion: [],
  };
  for (const f of result.findings) groups[f.severity].push(f);

  const sectionTitles: Record<Finding['severity'], string> = {
    bug: 'Bugs',
    ux_issue: 'UX issues',
    question: 'Design questions',
    suggestion: 'Suggestions',
  };

  let md = '';
  md += `# QA Session Report\n\n`;
  md += `**Scenario:** ${scenario.title}\n`;
  md += `**Persona:** ${persona.name}\n`;
  md += `**Starting URL:** ${result.starting_url}\n`;
  md += `**Outcome:** \`${result.outcome}\`\n`;
  md += `**Steps:** ${result.step_count}\n`;
  md += `**Duration:** ${result.duration_seconds}s\n`;
  md += `**Estimated LLM cost:** $${totalCost.toFixed(3)}\n`;
  if (result.notes) md += `**Notes:** ${result.notes}\n`;
  md += `\n---\n\n`;
  md += `## Findings (${result.findings.length})\n\n`;

  if (result.findings.length === 0) {
    md += `_No findings recorded._\n\n`;
  } else {
    for (const sev of ['bug', 'ux_issue', 'question', 'suggestion'] as const) {
      const items = groups[sev];
      if (items.length === 0) continue;
      md += `### ${sectionTitles[sev]} (${items.length})\n\n`;
      for (const f of items) {
        md += `#### ${f.summary}\n\n`;
        md += `- **Step:** ${f.step}${f.screenshot_ref ? ` ([screenshot](screenshots/${f.screenshot_ref}))` : ''}\n`;
        md += `- **Evidence:** ${f.evidence}\n`;
        md += `- **Why it matters:** ${f.why_it_matters}\n`;
        if (f.suggested_fix) md += `- **Suggested fix:** ${f.suggested_fix}\n`;
        md += `\n`;
      }
    }
  }

  md += `---\n\n`;
  md += `## Goal\n\n${scenario.goal}\n\n`;
  if (scenario.acceptance_criteria) {
    md += `### Acceptance criteria\n\n`;
    for (const c of scenario.acceptance_criteria) md += `- ${c}\n`;
    md += `\n`;
  }
  md += `## Persona prompt\n\n${persona.prompt}\n`;
  return md;
}
