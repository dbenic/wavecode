#!/usr/bin/env npx tsx
/**
 * Check .ai domain availability via whois.nic.ai
 * Usage: npx tsx scripts/check-domains.ts
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const NAMES = [
  { rank: 1, name: 'Verita',  root: 'Veritas',  meaning: 'Truth' },
  { rank: 2, name: 'Clara',   root: 'Clarus',   meaning: 'Clear / Clarity' },
  { rank: 3, name: 'Unara',   root: 'Unus',     meaning: 'One / Unified' },
  { rank: 4, name: 'Fidara',  root: 'Fides',    meaning: 'Trust / Faith' },
  { rank: 5, name: 'Ratara',  root: 'Ratio',    meaning: 'Reason / Calculation' },
  { rank: 6, name: 'Sapiara', root: 'Sapiens',  meaning: 'Wise / Wisdom' },
  { rank: 7, name: 'Verara',  root: 'Veritas',  meaning: 'Truth (modified)' },
];

type Result = {
  rank: number;
  name: string;
  domain: string;
  meaning: string;
  available: boolean | null;
  raw?: string;
};

async function checkDomain(entry: (typeof NAMES)[number]): Promise<Result> {
  const domain = `${entry.name.toLowerCase()}.ai`;
  try {
    const { stdout } = await execAsync(`whois -h whois.nic.ai ${domain}`, { timeout: 15_000 });
    const available = /domain not found/i.test(stdout) || /no match/i.test(stdout) || /not found/i.test(stdout);
    return { ...entry, domain, available, raw: stdout.slice(0, 200) };
  } catch (err) {
    return { ...entry, domain, available: null, raw: String(err) };
  }
}

async function main() {
  console.log('\nChecking .ai domain availability via whois.nic.ai …\n');

  // Sequential to avoid rate-limiting the WHOIS server
  const results: Result[] = [];
  for (const entry of NAMES) {
    process.stdout.write(`  Checking ${entry.name.toLowerCase()}.ai …`);
    const result = await checkDomain(entry);
    process.stdout.write(
      result.available === null
        ? ' ⚠️  unknown\n'
        : result.available
        ? ' ✅ available\n'
        : ' ❌ taken\n'
    );
    results.push(result);
    // Small delay to be polite to the WHOIS server
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n' + '─'.repeat(62));
  console.log('Rank  Domain              Status       Meaning');
  console.log('─'.repeat(62));

  for (const r of results) {
    const status =
      r.available === null ? '⚠️  UNKNOWN  ' : r.available ? '✅ AVAILABLE' : '❌ TAKEN    ';
    const rank = `#${r.rank}`.padEnd(5);
    const domain = r.domain.padEnd(20);
    console.log(`${rank} ${domain} ${status}  ${r.meaning}`);
  }

  console.log('─'.repeat(62));

  const available = results.filter(r => r.available === true);
  const taken = results.filter(r => r.available === false);
  const unknown = results.filter(r => r.available === null);

  console.log(`\n  Available: ${available.length}  |  Taken: ${taken.length}  |  Unknown: ${unknown.length}`);

  if (available.length > 0) {
    console.log('\n  Domains you can register:');
    for (const r of available) {
      console.log(`    → ${r.domain}  (${r.meaning})`);
    }
  }

  console.log();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
