/**
 * CLI handler for `wavecode qa` subcommands.
 * Wired into the main CLI in src/cli/index.ts.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { runScenario } from './runner.js';
import { getConfig } from '../server/config.js';

const QA_ROOT = path.resolve(import.meta.dirname);
const SCENARIOS_DIR = resolveAssetDir('scenarios');
const PERSONAS_DIR = resolveAssetDir('personas');
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), '.wavecode-qa');

/**
 * YAML scenarios/personas live alongside the .ts source. After tsc compiles,
 * dist/qa/ has only .js — the YAML stays in src/. Try dist-local first, then
 * fall back to the source tree two levels up (dist/qa → repo root → src/qa).
 */
function resolveAssetDir(name: string): string {
  const local = path.join(QA_ROOT, name);
  if (fs.existsSync(local)) return local;
  const fromDist = path.resolve(QA_ROOT, '..', '..', 'src', 'qa', name);
  if (fs.existsSync(fromDist)) return fromDist;
  return local;
}

export function registerQaCommands(program: Command): void {
  const qa = program.command('qa').description('QA agent — browser-driven testing with Claude vision');

  qa.command('run <scenario>')
    .description('Run a QA scenario with a given persona')
    .option('--persona <id>', 'Persona id (file under src/qa/personas/)', 'first-time-user')
    .option('--target-url <url>', 'Override the scenario starting URL')
    .option('--headless', 'Run browser headless (default)', true)
    .option('--headed', 'Run browser in headed mode (visible window)')
    .option('--max-steps <n>', 'Maximum steps before forcing completion', (v) => parseInt(v, 10))
    .option('--model <model>', 'Anthropic model id', 'claude-sonnet-4-5-20250929')
    .option('--output-dir <dir>', 'Where to write session output', DEFAULT_OUTPUT_DIR)
    .option('--attach-to <agent>', 'Attach report to a WaveCode agent (id or name) — appears under that agent\'s docs')
    .option('--wavecode-url <url>', 'WaveCode base URL for --attach-to', process.env.WAVECODE_URL ?? 'http://localhost:3777')
    .option('--wavecode-token <token>', 'Auth token for WaveCode', process.env.WAVECODE_TOKEN)
    .action(async (scenario: string, opts) => {
      const apiKey = resolveApiKey();
      if (!apiKey) {
        console.error(
          'Error: ANTHROPIC_API_KEY not found. Set it in the env or in config.yaml under llm.anthropic_api_key.',
        );
        process.exit(1);
      }

      const scenarioPath = resolveYamlFile(SCENARIOS_DIR, scenario);
      const personaPath = resolveYamlFile(PERSONAS_DIR, opts.persona);

      try {
        const result = await runScenario({
          scenarioPath,
          personaPath,
          targetUrlOverride: opts.targetUrl,
          apiKey,
          model: opts.model,
          outputDir: opts.outputDir,
          headless: !opts.headed,
          maxSteps: opts.maxSteps,
          attachToAgent: opts.attachTo
            ? {
                waveCodeUrl: opts.wavecodeUrl,
                waveCodeToken: opts.wavecodeToken,
                agentIdOrName: opts.attachTo,
              }
            : undefined,
        });
        process.exit(result.outcome === 'completed' ? 0 : 2);
      } catch (e) {
        const msg = e instanceof Error ? e.stack ?? e.message : String(e);
        console.error(`QA run failed: ${msg}`);
        process.exit(1);
      }
    });

  qa.command('list-scenarios')
    .description('List available QA scenarios')
    .action(() => listYamlFiles(SCENARIOS_DIR));

  qa.command('list-personas')
    .description('List available QA personas')
    .action(() => listYamlFiles(PERSONAS_DIR));
}

function resolveApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const cfg = getConfig() as { llm?: { anthropic_api_key?: string } };
    if (cfg.llm?.anthropic_api_key) return cfg.llm.anthropic_api_key;
  } catch {
    // config not loaded — fall through
  }
  return undefined;
}

function resolveYamlFile(dir: string, id: string): string {
  // Allow either an id ("first-time-user") or a full path
  if (id.endsWith('.yaml') || id.endsWith('.yml')) {
    if (fs.existsSync(id)) return id;
  }
  const candidate = path.join(dir, `${id}.yaml`);
  if (fs.existsSync(candidate)) return candidate;
  const altCandidate = path.join(dir, `${id}.yml`);
  if (fs.existsSync(altCandidate)) return altCandidate;
  throw new Error(`Could not find ${id} in ${dir} (.yaml or .yml)`);
}

function listYamlFiles(dir: string): void {
  if (!fs.existsSync(dir)) {
    console.log(`(no files in ${dir})`);
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => f.replace(/\.(yaml|yml)$/, ''));
  if (files.length === 0) {
    console.log(`(no files in ${dir})`);
    return;
  }
  for (const f of files) console.log(`  ${f}`);
}
