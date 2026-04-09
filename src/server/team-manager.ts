import fs from 'node:fs';
import path from 'node:path';
import {
  getDb, generateId, getAgent, listAgents,
  type Agent, type Result,
} from './db.js';
import { emit } from './event-bus.js';
import * as sessionManager from './session-manager.js';
import logger from './logger.js';
import { getTeamsRoot } from './runtime-launcher.js';

// --- Types ---

export interface Team {
  id: string;
  name: string;
  description: string;
  created_at: string;
}

export interface TeamMember {
  team_id: string;
  agent_id: string;
  role: string; // 'implementer' | 'reviewer' | 'spec-writer' | 'tester' | custom
}

export interface TeamMessage {
  id: string;
  team_id: string;
  from_agent_id: string;
  to_agent_id: string | null; // null = broadcast to team
  filename: string;
  content: string;
  status: 'pending' | 'delivered' | 'read';
  created_at: string;
}

// --- DB setup ---

export function ensureTeamTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL REFERENCES teams(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      role TEXT NOT NULL DEFAULT 'member',
      PRIMARY KEY (team_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS team_messages (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id),
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_team_messages_team ON team_messages(team_id, created_at);
  `);
}

// --- Team CRUD ---

export function createTeam(name: string, description: string = ''): Result<Team> {
  const id = generateId();
  try {
    getDb().prepare(
      'INSERT INTO teams (id, name, description) VALUES (?, ?, ?)'
    ).run(id, name, description);

    // Create shared directory
    const teamDir = getTeamDir(name);
    fs.mkdirSync(path.join(teamDir, 'specs'), { recursive: true });
    fs.mkdirSync(path.join(teamDir, 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(teamDir, 'comms'), { recursive: true });

    // Create initial team-context.md
    fs.writeFileSync(path.join(teamDir, 'team-context.md'),
      `# Team: ${name}\n\n${description}\n\n## Members\n(assigned via WaveCode)\n\n## Shared Files\n- specs/ — specifications and design docs\n- reviews/ — code review feedback\n- comms/ — agent-to-agent messages\n`
    );

    emit('team.created', 'team', id, { name });
    logger.info({ teamId: id, name }, 'Team created');

    const team = getDb().prepare('SELECT * FROM teams WHERE id = ?').get(id) as Team;
    return { ok: true, data: team };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function listTeams(): Team[] {
  return getDb().prepare('SELECT * FROM teams ORDER BY created_at DESC').all() as Team[];
}

export function getTeam(idOrName: string): Result<Team> {
  const team = getDb().prepare(
    'SELECT * FROM teams WHERE id = ? OR name = ?'
  ).get(idOrName, idOrName) as Team | undefined;
  if (!team) return { ok: false, error: `Team '${idOrName}' not found` };
  return { ok: true, data: team };
}

// --- Members ---

export function addMember(teamId: string, agentId: string, role: string = 'member'): Result<void> {
  try {
    getDb().prepare(
      'INSERT OR REPLACE INTO team_members (team_id, agent_id, role) VALUES (?, ?, ?)'
    ).run(teamId, agentId, role);

    // Update agent's context with team info
    updateAgentTeamContext(teamId, agentId);

    emit('team.member_added', 'team', teamId, { agent_id: agentId, role });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function getTeamMembers(teamId: string): (TeamMember & { agent_name: string; runtime: string })[] {
  return getDb().prepare(`
    SELECT tm.*, a.name as agent_name, a.runtime
    FROM team_members tm
    JOIN agents a ON a.id = tm.agent_id
    WHERE tm.team_id = ?
  `).all(teamId) as (TeamMember & { agent_name: string; runtime: string })[];
}

export function getAgentTeams(agentId: string): Team[] {
  return getDb().prepare(`
    SELECT t.* FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    WHERE tm.agent_id = ?
  `).all(agentId) as Team[];
}

// --- Shared context directory ---

function getTeamDir(teamName: string): string {
  return path.join(getTeamsRoot(), teamName);
}

// --- Update agent with team context ---

function updateAgentTeamContext(teamId: string, agentId: string): void {
  const teamResult = getTeam(teamId);
  if (!teamResult.ok) return;

  const team = teamResult.data;
  const members = getTeamMembers(teamId);
  const agentResult = getAgent(agentId);
  if (!agentResult.ok) return;

  const agent = agentResult.data;
  const teamDir = getTeamDir(team.name);

  // Build team context instruction
  const memberList = members.map((m) =>
    `  - ${m.agent_name} [${m.runtime}] — role: ${m.role}${m.agent_id === agentId ? ' (you)' : ''}`
  ).join('\n');

  const myRole = members.find((m) => m.agent_id === agentId)?.role ?? 'member';

  const teamInstruction = `You are part of team "${team.name}". ${team.description}

Your role: ${myRole}

Team members:
${memberList}

Shared files directory: ${teamDir}
- ${teamDir}/specs/ — write specifications and design docs here
- ${teamDir}/reviews/ — write review feedback here
- ${teamDir}/comms/ — write messages to other team members here

To send a message to a teammate:
  Create a file: ${teamDir}/comms/<target-agent-name>-<topic>.md
  WaveCode will deliver it automatically.

To broadcast to the whole team:
  Create a file: ${teamDir}/comms/team-<topic>.md

Always check ${teamDir}/comms/ for new messages from teammates before starting new work.
Read ${teamDir}/team-context.md for shared project knowledge.`;

  // Send the team context to the agent
  sessionManager.sendKeys(agentId, teamInstruction);

  // Update team-context.md with current members
  const contextPath = path.join(teamDir, 'team-context.md');
  if (fs.existsSync(contextPath)) {
    const content = `# Team: ${team.name}\n\n${team.description}\n\n## Members\n${memberList}\n\n## Shared Files\n- specs/ — specifications and design docs\n- reviews/ — code review feedback\n- comms/ — agent-to-agent messages\n`;
    fs.writeFileSync(contextPath, content);
  }
}

// --- File-based communication watcher ---

const watchers = new Map<string, fs.FSWatcher>();

export function startCommsWatcher(teamName: string): void {
  const commsDir = path.join(getTeamDir(teamName), 'comms');
  if (!fs.existsSync(commsDir)) return;
  if (watchers.has(teamName)) return;

  const watcher = fs.watch(commsDir, (eventType, filename) => {
    if (eventType !== 'rename' || !filename || !filename.endsWith('.md')) return;

    const filePath = path.join(commsDir, filename);
    if (!fs.existsSync(filePath)) return;

    // Parse target from filename: "cl-backend-review.md" → target: cl-backend
    // "team-update.md" → broadcast
    const content = fs.readFileSync(filePath, 'utf-8');
    const isBroadcast = filename.startsWith('team-');

    const teamResult = getTeam(teamName);
    if (!teamResult.ok) return;

    const members = getTeamMembers(teamResult.data.id);

    if (isBroadcast) {
      // Send to all team members
      for (const member of members) {
        const agentResult = getAgent(member.agent_id);
        if (!agentResult.ok) continue;
        sessionManager.sendKeys(member.agent_id,
          `[Team message from teammate] File: ${filename}\n\n${content.substring(0, 3000)}`
        );
      }
      logger.info({ team: teamName, file: filename }, 'Team broadcast delivered');
    } else {
      // Parse target agent name from filename
      const targetName = filename.replace(/-[^-]+\.md$/, '');
      const targetMember = members.find((m) => m.agent_name === targetName);
      if (targetMember) {
        sessionManager.sendKeys(targetMember.agent_id,
          `[Message from teammate] File: ${filename}\n\n${content.substring(0, 3000)}`
        );
        logger.info({ team: teamName, file: filename, target: targetName }, 'Team message delivered');
      }
    }

    // Record the message
    const msgId = generateId();
    getDb().prepare(`
      INSERT INTO team_messages (id, team_id, from_agent_id, to_agent_id, filename, content, status)
      VALUES (?, ?, 'unknown', NULL, ?, ?, 'delivered')
    `).run(msgId, teamResult.data.id, filename, content.substring(0, 5000));

    emit('team.message', 'team', teamResult.data.id, {
      filename,
      broadcast: isBroadcast,
    });

    // Move processed file to avoid re-delivery
    const processedDir = path.join(getTeamDir(teamName), 'comms', '.processed');
    if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });
    fs.renameSync(filePath, path.join(processedDir, `${Date.now()}-${filename}`));
  });

  watchers.set(teamName, watcher);
  logger.info({ team: teamName }, 'Comms watcher started');
}

export function stopCommsWatcher(teamName: string): void {
  const watcher = watchers.get(teamName);
  if (watcher) {
    watcher.close();
    watchers.delete(teamName);
  }
}

export function stopAllCommsWatchers(): void {
  for (const teamName of watchers.keys()) {
    stopCommsWatcher(teamName);
  }
}

export function startAllCommsWatchers(): void {
  const teams = listTeams();
  for (const team of teams) {
    startCommsWatcher(team.name);
  }
}

// --- Team messages ---

export function getTeamMessages(teamId: string, limit: number = 50): TeamMessage[] {
  return getDb().prepare(
    'SELECT * FROM team_messages WHERE team_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(teamId, limit) as TeamMessage[];
}
