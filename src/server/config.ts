import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { DEFAULT_OPS_DIR, DEFAULT_OPS_OWNERS, DEFAULT_OPS_POLL_S, DEFAULT_OPS_RECEIPTS, DEFAULT_OPS_ROLES, DEFAULT_OPS_STALE_MIN, type OpsLanesConfig } from './ops-lanes-config.js';
import { validateProfilesConfig } from './profile-validation.js';

export interface RuntimeConfig {
  command: string;
  idle_pattern: string;
  /** CLI flag used to pass a pinned model (e.g. '--model'). Unset = pin is recorded but not injected. */
  model_flag?: string;
  /** CLI flag used to pass a pinned reasoning effort (e.g. '--effort'). Unset = pin is recorded but not injected. */
  effort_flag?: string;
  /** Models the UI offers for this runtime. Codex lists its own cache when this is unset. */
  models?: string[];
  /**
   * Appended when WaveCode relaunches a runtime that ran before in this
   * worktree, so the CLI resumes its previous conversation instead of
   * starting blank (`--continue` for Claude Code, `resume --last` for Codex).
   * The first relaunch attempt resumes; if the runtime dies again it is
   * launched plain, so a missing session can never loop.
   */
  resume_args?: string;
  /**
   * Env injected at launch when the agent runs on a credential profile
   * (spec §5). Values are templates; `{profile_dir}` → `<profiles_root>/<profile>`.
   */
  env?: Record<string, string>;
  /** Command a login seat runs for this runtime (e.g. `claude /login`). */
  login_command?: string;
  /** Files whose presence means "logged in" (templates, `{profile_dir}`). Contents are never read. */
  credential_files?: string[];
  /** How prompts enter the TUI: 'paste' (bracketed paste + confirmed Enter, default) or 'type' (chunked keystrokes). */
  input_mode?: 'paste' | 'type';
  // Future deploy agent fields (optional)
  scope?: string;
  claude_md?: string;
  workspace?: string;
  ssh_key?: string;
}

export interface ProjectGateConfig {
  /** Executable on PATH or an absolute path. WaveCode never cds into a worktree. */
  command: string;
  /** Shared-checkout branch the referee fetches (e.g. landing-v3-human-first). */
  branch: string;
  /** Promote always uses full. */
  mode?: 'fast' | 'full';
  /**
   * Newest matching nightly `*-full.log` used as the known-red baseline.
   * If omitted, WaveCode looks for `~/gate-results/<branch-with-/-as-->-*-full.log`.
   */
  baseline_glob?: string;
}

export interface PrereqCheckConfig {
  /** Argv template. `{sha}` and `{project}` are replaced. Exit 0 passes. */
  command: string[];
  /** `exit` (default) or `ndjson` (read a named field from the last JSON line that has it). */
  type?: 'exit' | 'ndjson';
  field?: string;
  compare?: '>=' | '>' | '==' | '<=' | '<' | '!=';
  value?: number | string;
}

export interface ProjectConfig {
  // Glob or prefix matched against agents.workspace (e.g. "**/" + "wavepulse*").
  workspace_match: string;
  gate?: ProjectGateConfig;
  /** When a gate is configured this defaults to true — RESULT is required to promote. */
  require_result_to_promote?: boolean;
  /** Optional per-agent branch override (agent name → branch). */
  agent_branches?: Record<string, string>;
  /** Base clone agents get worktrees of (e.g. /home/wave/repos/wavepulse). Told to seats; default repo for spawns. */
  repo?: string;
  /**
   * `peer/agent` (e.g. `deploy/fable`) that receives the release GO when a
   * person promotes a run of this project. The message is attributed to that
   * person ("Release GO from denis via WaveCode Promote"); agents cannot
   * produce it — their ASK lines always arrive as questions.
   */
  release_peer?: string;
  /**
   * Run in every new worktree right after it is created, as the service user
   * (e.g. `npm ci --no-audit --no-fund`). Detached; output in
   * `<worktree>/.wavecode-setup.log`; the agent is told when it finishes.
   */
  setup_command?: string;
  /**
   * Glob over remote branch names (without `origin/`) that are release candidates composed by
   * the deployer, e.g. `fable/rc-*`. A lane whose SHA sits in an unreleased candidate is
   * "in candidate": it ships with that release, is not an open fix and is not promoted alone.
   */
  candidate_refs?: string;
  /**
   * Remote and branch that lanes must contain before they can be frozen or staged.
   * Default `origin` / `main`.
   */
  main_remote?: string;
  main_branch?: string;
  /** Glob over remote branch names (without the remote) that are developer lanes. Default `wc-*`. */
  lane_glob?: string;
  /** Paths a developer lane must not change. The status line names the path as configured. */
  protected_paths?: string[];
  /** Directory of schema migrations, relative to the repo. A lane that touches it is not staged with STAGE. */
  migrations_dir?: string;
  /** Shown on a lane card that has no freeze yet. Default text lives in lane-status.ts. */
  before_freeze_tip?: string;
  /**
   * Test runner for this project. Each command is an argv template.
   * `{lane}` and `{sha}` fill status and history; `{id}` fills the log command.
   * The process prints one JSON document (schema v1). No shell.
   */
  tests?: {
    status_command?: string[];
    history_command?: string[];
    log_command?: string[];
    /**
     * Suite names that count as the quick check. Default `quick` and `tier1`.
     * A green one of these, or a green full run, is enough to stage.
     */
    quick_suites?: string[];
    /**
     * Suite names that count as the full gate, along with `kind: gate`.
     * Default `full-tuned` and `full`. Production Promote needs one of these green.
     */
    full_suites?: string[];
  };
  /**
   * Hands-free lane pipeline. Every switch defaults off. Push and the quick
   * check are argv templates, not a shell. `{lane}` in the push command is the
   * lane branch; the daemon never pushes main.
   */
  pipeline?: {
    auto_freeze?: boolean;
    auto_gate?: boolean;
    auto_review?: boolean;
    auto_stage?: boolean;
    /** When main advances, clean-merge it into open lanes and refreeze. */
    auto_merge_main?: boolean;
    quick_check_command?: string[];
    push_command?: string[];
    gate_command?: string[];
    /** Author name → reviewer name. The author, `review_deny`, and `agent_deny` are never chosen. */
    review_routes?: Record<string, string>;
    /** Agent name or alias. Never a reviewer, and excluded from lane pings and auto-merge. */
    review_deny?: string[];
    /**
     * Globs over lane branch names that get no Countix automation
     * (no merge, ping, freeze, or Reviews card).
     */
    lane_deny?: string[];
    /**
     * Agent names or aliases that get no Countix automation.
     * Also excluded from reviewer choice, the same as `review_deny`.
     */
    agent_deny?: string[];
    /**
     * First choice inside the eligible set, by the author's vendor
     * (`claude-code` → `claude`). The least-loaded name in the first
     * non-empty tier wins. Empty means the route map is next.
     */
    reviewer_prefer?: Record<string, string[]>;
    /**
     * Author-name glob → seats that may review that person, including their
     * own other seats (`ales-*` → `ales-codex1`). Never the author, and never
     * a denied name.
     */
    reviewer_pool_by_author_glob?: Record<string, string[]>;
    /**
     * Reassign a review that has waited this many minutes on a busy seat
     * with no verdict. 0 disables. Default 15.
     */
    review_reassign_minutes?: number;
    /** Directory for generated freeze notes. Falls back to `review.freeze_inbox`. */
    freeze_dir?: string;
    /**
     * One remote run per freeze: skip the separate quick check and submit the
     * full gate as soon as the freeze lands, while the review runs. For a
     * dispatcher that refuses the same SHA twice.
     */
    gate_with_quick?: boolean;
    /** How long the full gate may run before it counts as RED. Default 120. */
    gate_timeout_min?: number;
    /** How long the quick check may run. Default 20. */
    quick_check_timeout_min?: number;
    /** Full gates running at once per project; the rest wait in WaveCode. Default 3. */
    gate_max_inflight?: number;
    /** A lane that changes more files than this gets a size warning in the review ping. 0 disables. Default 40. */
    max_lane_files?: number;
    /**
     * Rolling candidate review: after every main advance one seat reviews the diff since the last
     * reviewed candidate (docs/ops/engine-fixes-27oct-plan.md). Default: on when `auto_review` is on.
     */
    candidate_review?: boolean;
    /** Minutes until a candidate review with no answer is chased. Default 45. */
    candidate_review_timeout_min?: number;
    /**
     * Told to the test gateway when a run WaveCode submitted is superseded (`{sha}` = the old SHA);
     * the local submission is abandoned either way.
     */
    cancel_command?: string[];
    /**
     * When set, only these seats (name or alias) may be picked as reviewers,
     * besides the prefer tiers and the author-glob pools. Keeps the open
     * ladder away from other people's seats.
     */
    reviewer_allow?: string[];
    /**
     * Credential profiles that are service pools, not one person's seats
     * (`denis20x` runs codex4 to codex8 and claude3 to claude6). Two seats on
     * such a profile may review each other.
     */
    service_profiles?: string[];
    /**
     * WaveCode merges eligible lanes into main itself (docs/merge-queue.md).
     * Off unless `enabled` is true; the runtime kill switch is the kv flag
     * `merge_queue.<project>` and the Reviews page toggle.
     */
    merge_queue?: MergeQueueConfig;
  };
  /**
   * Operational checks named by a freeze note's `prereqs:` block. Absent
   * means no extra Promote gate. A declared id with no entry refuses Promote.
   * Commands run as argv on this box (the deploy box). `code_deploy` is not a check.
   */
  prereq_checks?: Record<string, PrereqCheckConfig>;
}

export type MergeTier = 'ship' | 'show' | 'ask';

export interface MergeQueueConfig {
  enabled?: boolean;
  /**
   * Path globs (`migrations/**`, `**\/payroll/**`) that force tier `ask`.
   * `projects.<p>.migrations_dir` is always one of them.
   */
  ask_paths?: string[];
  /** Tier when the freeze note has no `TIER:` line. Unset: the note must name one. */
  default_tier?: MergeTier;
  /**
   * How an ask-tier lane gets its OK. `label` (default): an open pull request with
   * `github.ok_label`. `auto`: no label and no pull request needed; ask-tier lanes merge
   * like the rest once the gates are green and a PASS is on the SHA (Denis, 26 Oct 2026:
   * "I don't want to approve anything"). Hold labels on an open PR still park the lane.
   */
  ask_tier?: 'label' | 'auto';
  /**
   * Run in the merge checkout before the merge commit is sealed (a version
   * bump). Its file changes are folded into the merge commit. Argv, no shell.
   */
  version_command?: string[];
  /**
   * Prints the open pull requests as JSON (`gh pr list --json number,headRefName,headRefOid,state`).
   * Without it the remote's `refs/pull/*\/head` is read, which cannot tell open from closed.
   */
  pr_list_command?: string[];
  /** A lane needs a pull request before it is merged. Default true. */
  require_pr?: boolean;
  /** Append one line per merge or bounce here (the coordinating bot reads it). */
  maestro_log?: string;
  /**
   * The full suite, run once on the merged code before the push (the testing study
   * of 25 Oct 2026: this is the only full run). Argv, no shell; `{sha}` is the merge
   * SHA. Default `pipeline.gate_command`.
   */
  gate_command?: string[];
  /** Minutes the gate on the merge result may run. Default `pipeline.gate_timeout_min`. */
  gate_timeout_min?: number;
  /**
   * Lanes the queue never merges (globs). Default main, master, release/*, prod-*;
   * the project's `main_branch` is always denied. There is no allowlist: any other
   * branch with a freeze note may queue (brief of 26 Oct 2026).
   */
  deny_lanes?: string[];
  /**
   * GitHub through `gh` with a server-side credential: the open pull requests and
   * their labels (the ask-tier OK, the migration hold). `gh auth status` is checked
   * before every pass; while it fails the whole queue refuses with `GH_AUTH_MISSING`
   * and raises the stall file.
   */
  github?: MergeQueueGithubConfig;
  /** Minutes an eligible lane may wait with no merge progress before the stall file is written. Default 30. */
  stall_minutes?: number;
  /** Directory for `wavecode-queue-stall-<ts>.md`. Default: the `maestro_log` directory, else the first freeze inbox. */
  stall_dir?: string;
}

export interface MergeQueueGithubConfig {
  /** `owner/name`. */
  repo: string;
  /**
   * File holding the fine-grained token (contents and pull_requests on the repo; no checks),
   * stored by SystemOps, readable by the service user only. Read at tick time and handed
   * to `gh` as `GH_TOKEN`; never logged. Unset: the service user's own `gh auth login`.
   */
  token_file?: string;
  /** Pull-request label that is Denis's OK for an ask-tier lane. Default `ok-to-merge`. */
  ok_label?: string;
  /** Pull-request labels that park a lane (`MIGRATION_HOLD`). Default `migration-hold`, `do-not-merge`. */
  hold_labels?: string[];
}

/**
 * Slack bridge (docs/slack-bridge.md): Slack messages become prompts to a seat and the seat's
 * captured reply is posted back in the thread. A separate Slack app from any other bot.
 * Tokens live in files placed by SystemOps (0600, service user), never here.
 */
export interface SlackConfig {
  /** File with the app-level token (`xapp-…`, Socket Mode). */
  app_token_file: string;
  /** File with the bot token (`xoxb-…`, Web API). */
  bot_token_file: string;
  /** Agent name that answers DMs and bare @mentions (Denis's own seat). */
  dm_seat?: string;
  /**
   * Channel routes by Slack channel ID. `mode: all` answers every message there; default only
   * @mentions. `users`: Slack user IDs allowed in that channel (a private channel for one person);
   * unset = everyone in `slack.users`.
   */
  routes?: Array<{ channel: string; seat: string; name?: string; mode?: 'mention' | 'all'; users?: string[] }>;
  /** Slack user ID → WaveCode user name. Anyone else is refused in one line. */
  users?: Record<string, string>;
  /** Channel ID that also receives WaveCode notifications (alerts), optional. */
  notify_channel?: string;
  /** How long to wait for the seat's captured reply, seconds (default 600, the reply-capture ceiling). */
  reply_timeout_s?: number;
}

export interface PeerConfig {
  /** Base URL of the peer daemon, reachable over the tailnet (http://100.x.y.z:3777). */
  url: string;
  /** Bearer token of a user on the peer. Never printed; never the peer's admin token. */
  token: string;
  /** Optional allowlist of remote agent handles (alias or name) that may be asked. */
  agents?: string[];
}

export interface ProfileConfig {
  /** Shared profiles (referee-style service seats) are admin-only. */
  shared?: boolean;
  /**
   * Public profiles are the opposite: agents on them may be used by every
   * user (a pool agent paid by one subscription). Spawning on them stays
   * admin-only; using the agents that exist is open to all.
   */
  public?: boolean;
}

export interface DeveloperConfig {
  name: string;
  users?: string[];
  tokens?: string[];
  lanes: string[];
}

export interface WaveConfig {
  server: {
    port: number;
    host: string;
  };
  paths: {
    projects_root: string;
    worktrees_root: string;
    transcripts_root: string;
    teams_root: string;
    guides_root: string;
    templates_root: string;
    /** Project rooms (spec §5e): `<rooms_root>/<project>/` with SPEC.md, LEDGER.md, REPORTS/ … */
    rooms_root: string;
    /** Extra directories the file viewer may serve (e.g. a shared inbox). Rooms, worktrees, projects, transcripts and artifacts are always included. */
    browse_roots?: string[];
    /** Hand-off folders to watch: a new file is announced to its addressed agent (default ['~/inbox/from-fable']). */
    inbox_watch?: string[];
  };
  /** Per-project verify/referee profiles. Unmatched workspaces keep today's behavior. */
  projects: Record<string, ProjectConfig>;
  autonomy: {
    auto_dispatch: boolean;
    auto_restart: boolean;
    hang_timeout_min: number;
    /**
     * What a quiet "working" pane after hang_timeout_min means. 'alert' (default):
     * agent.hung + notification, nothing killed — an interactive session with a
     * long silent step is not broken, and killing it loses its conversation.
     * 'restart': kill + recreate, but only when a WaveCode run is open on the
     * agent (task-driven work the dispatcher can re-queue).
     */
    hang_action: 'alert' | 'restart';
    max_task_retries: number;
    verify_completion: boolean;
    /**
     * Clear the runtime's conversation (`/clear` for Claude Code, `/new` for Codex, `/clear` for
     * Aider) before a task prompt goes into a pane, unless the task is a fix round on the same
     * lane or says `context: 'keep'`. Default true. A long session carries stale SHAs, verdicts
     * and reversed instructions into the next task (28 Oct 2026).
     */
    fresh_context?: boolean;
    /** Auto-dispatch skips, and create_task refuses, an agent whose 5h/weekly window has less than this left. Default 10. */
    min_quota_pct?: number;
  };
  sandbox: {
    disable_git_push: boolean;
    restrict_network: boolean;
  };
  runtimes: Record<string, RuntimeConfig>;
  /** Root of per-developer credential dirs: `<profiles_root>/<profile>/…` (spec §5). */
  profiles_root: string;
  /** Configured credential profiles. Empty = feature off (agents use the home-dir login). */
  profiles: Record<string, ProfileConfig>;
  /** Default Command Center target: the orchestrator (PM) seat by agent name (spec §5b). */
  orchestrator_agent: string | null;
  /** Nightly retro (spec §5f): each active room's seat proposes template / ROOM.md changes. */
  retro: { nightly: boolean; hour_utc: number; window_days: number };
  auth: {
    method: 'tailscale' | 'token';
    fallback_token: string | null;
    trusted_proxies: string[];
    /**
     * tailscale mode only: a token-less caller on the loopback socket is NOT
     * made owner unless this is true — behind `tailscale serve` or any local
     * proxy every client looks like 127.0.0.1. Prefer token mode.
     */
    allow_loopback_owner?: boolean;
  };
  notifications: {
    web_push: boolean;
    ntfy_topic: string | null;
    telegram_bot_token: string | null;
    telegram_chat_id: string | null;
  };
  /** Journal retention: pane-output ticks for a day, everything else for 90 days (event-retention.ts). */
  events?: {
    short_lived_types?: string[];
    short_hours?: number;
    retention_days?: number;
  };
  artifacts: {
    storage: string;
    retention_days: number;
    /**
     * Drop folders for development fixtures: any file put there (by a person, an agent, or
     * scp from the deploy box) becomes a kept artifact. Sub-folders name the room and the
     * desk (`<inbox>/wavepulse/desk91/invoice.xml`), or the file name carries them.
     */
    fixture_inbox?: string[];
  };
  /**
   * Other WaveCode instances agents may ask questions of (e.g. the deploy
   * box). `token` is a user on THAT instance; scope it there with a profile
   * so it can reach only the answering agent (docs/peers.md).
   */
  peers: Record<string, PeerConfig>;
  /** Slack bridge; absent = no bridge. */
  slack?: SlackConfig;
  review: {
    auto_review: boolean;
    default_reviewer: string;
    self_review: boolean;
    max_fix_loops: number;
    /** Block promote unless the latest completed review verdict is 'pass' (override requires a stored reason). */
    require_pass_to_promote: boolean;
    /** Dependent tasks dispatch only after their dependency's run is human-approved, not merely 'done'. */
    gate_dependents_on_approval: boolean;
    /**
     * Assignment ladder rungs 3–4: with no explicit or configured reviewer,
     * pick a free agent (tag `review` first, other vendor preferred). Off =
     * the run waits with a "needs a reviewer" item until someone picks.
     */
    auto_pick: boolean;
    /**
     * Folders where authors drop freeze notes and reviewers drop verdict files
     * (`*freeze*.md`, `*verdict*.md` with an exact SHA and `VERDICT: PASS|NEEDS FIXES`).
     * Each reviewed SHA becomes a Review-queue card whose Promote relays the GO.
     * Unset = off (a deploy box's inbox holds GO files, not freezes).
     */
    freeze_inbox?: string[];
    /**
     * A seat whose plan (5-hour or weekly window, read by the usage probe)
     * has less than this left is not picked as a reviewer. Default 10.
     */
    min_capacity_pct?: number;
    /**
     * Token-cheap first pass on every freeze, run on a seat: the least-loaded
     * listed seat with capacity gets the one-pass prompt and writes
     * `wave-firstpass-<sha8>-<date>.md` into `dir` (default: the freeze
     * inbox). The result is announced to the reviewer and, on NEEDS FIXES,
     * to the author. It is never a verdict. Off by default.
     */
    first_pass?: {
      enabled?: boolean;
      /** Seats (name or alias) that may run the first pass. Never the author or the author's own seats. */
      seats?: string[];
      dir?: string;
      /** Minutes until a missing first pass is noted as such. Default 20. */
      timeout_min?: number;
    };
  };
  /**
   * Who is looking at Reviews. `users` matches the logged-in user name.
   * `tokens` matches the bearer token they presented. `lanes` are globs.
   * An identity that matches nobody sees every lane.
   */
  developers?: DeveloperConfig[];
  /**
   * Releases (src/server/releases.ts). On the deploy box: the agent that receives staging
   * and production requests (alias, name or id). A box without it forwards requests to
   * `projects.<p>.release_peer`.
   *
   * `production_approvers` is the deploy box's allow-list of user names that may originate
   * a production release forwarded by a peer. Empty or unset refuses every such request.
   * Staging requests from peers are not checked against it.
   *
   * `staging_command` is an argv template. When set, a staging release runs it directly
   * instead of prompting the deploy agent. `{sha}` is required; `{lane}` and `{desk}` are
   * optional and dropped (with the preceding `--flag`) when empty. `staging_watch_command`
   * re-attaches after a restart and must include `{deploy_id}`. `production_command` does the
   * same for Promote: when set, no LLM is on the production path.
   */
  releases?: {
    deploy_agent?: string | null;
    production_approvers?: string[];
    /**
     * "Main is the only road to prod" (Denis, 26 Oct 2026): a production release request is
     * refused unless `wavecode deployable` says YES (on origin/main, contains what prod runs,
     * quick + api GREEN on the exact SHA). Default off so older boxes keep their flow.
     */
    main_only?: boolean;
    staging_command?: string[];
    staging_watch_command?: string[];
    /**
     * Argv template for a production release on the deploy box (27 Oct 2026). When set,
     * Promote runs it instead of prompting the deploy agent: a deterministic runner, no LLM
     * on the production path. `{sha}` is required; `{release_id}`, `{lane}` and `{desk}` are
     * optional. Progress lines use the staging schema: `done` = deployed, `failed` = failed,
     * a silent non-zero exit = failed. There is no watch command: a daemon restart mid-run
     * leaves the row `sent` and the `prod_health_command` reconciler finds the real tip.
     */
    production_command?: string[];
    /**
     * Optional argv that prints the SHA (and version) actually on staging.
     * When it returns a SHA it wins over the latest deployed record.
     * Off unless set. `{project}` is optional.
     */
    staging_health_command?: string[];
    /**
     * Optional argv that prints the SHA (and version) actually on production.
     * When it returns a SHA it wins over the latest deployed production record.
     * Off unless set. `{project}` is optional. A missing SHA is unknown — the
     * reconciler does not assume the commit is absent.
     */
    prod_health_command?: string[];
    /**
     * Minutes a person's own Slack GO stays valid for their seat's production request
     * (src/server/slack-go.ts). Default 15.
     */
    slack_go_window_min?: number;
  };
  /**
   * Delivery tracker (src/server/deliveries.ts, docs/ops/delivery-tracker-plan.md). `notify`: agent
   * aliases that get every stall message (the driver seat, e.g. pm-denis). `budgets_min`: Start-To-Close
   * budget per stage in minutes, overriding the defaults in deliveries.ts.
   */
  deliveries?: {
    notify?: string[];
    /** Open a PD-<n> delivery for every freeze that carries a desk number (default true). */
    auto_desk?: boolean;
    /** Open a record for every running task and every developer lane ahead of main that no record covers (default true, 28 Oct 2026). */
    auto_track?: boolean;
    budgets_min?: Partial<Record<'spec' | 'build' | 'first_pass' | 'gates' | 'review' | 'land' | 'candidate' | 'release', number>>;
  };
  /**
   * The coordinator (src/server/overlord.ts): wakes on board-changing events and a heartbeat,
   * calls `model` on the configured LLM key (llm.anthropic_api_key), posts reports with
   * one-click recommendations. Off unless `enabled: true` (the default is off): nothing in a
   * lane, a review or the merge queue waits on it, so switching it off changes no flow.
   * It never acts on its own.
   */
  overlord?: {
    enabled?: boolean;
    model?: string;
    heartbeat_min?: number;
    max_wakes_per_hour?: number;
    debounce_s?: number;
    notify?: boolean;
    /** Stage every reviewed PASS lane automatically (in the overlord's name). Production never. */
    auto_stage?: boolean;
  };
  /**
   * Product Desk (the Countix request board) read into WaveCode with the per-server dev-lane
   * token (docs/PRODUCT_DESK_AGENT_PROTOCOL.md). Off unless enabled. The token file is a curl
   * config (`header = "Authorization: Bearer …"`) owned by the service user; it is read per call
   * and never logged.
   */
  /** countix-testing status portal (GET /api/status, schema 1), shown on the Tests page. Unset = hidden. */
  test_portal?: {
    url?: string;
    poll_s?: number;
  };
  /**
   * Live terminal view on the agent page: `tmux pipe-pane` → FIFO → WebSocket →
   * xterm.js. `enabled` default true; `fifo_dir` default `<data>/terminal`;
   * `max_viewers` default 20 (open sockets across all agents).
   */
  terminal_stream?: {
    enabled?: boolean;
    fifo_dir?: string;
    max_viewers?: number;
  };
  /**
   * Ops lanes Live board and job store. One `<role>.json` in `dir`.
   * Defaults: `/srv/opsbots/heartbeat`, receipts under `/srv/opsbots/receipts`,
   * poll 10s, stale after 2 minutes, owners denis and antonio.
   * WaveCode records jobs. It does not run the opsbots scripts.
   */
  ops_lanes?: OpsLanesConfig;
  product_desk?: {
    enabled?: boolean;
    url?: string;
    token_file?: string;
    poll_min?: number;
    /** project room for tasks created from desk requests */
    project?: string | null;
  };
  /** Self-service spawning: at most this many agents per non-admin user's profile (unset = no limit). */
  spawn?: { max_per_user?: number | null };
  /**
   * Subscription usage probe: WaveCode types /status (Codex) or /usage (Claude) into one idle agent per profile every N minutes (0 = off).
   * `alert_used_pct` (default 80, 0 = off): when a profile's 5-hour or weekly window passes it, one `usage.high` notification per window.
   */
  usage?: { probe_interval_min?: number; alert_used_pct?: number };
  /** Diagram rendering: a self-hosted Kroki (https://kroki.io) for D2 / PlantUML / Graphviz blocks and files. Mermaid renders in the browser. */
  diagrams?: { kroki_url?: string | null };
  llm: {
    provider: 'anthropic' | 'openai-compatible';
    api_key: string | null;
    anthropic_api_key: string | null;
    /** Sent as the anthropic-workspace-id header; required when the key is not scoped to a workspace. */
    anthropic_workspace_id?: string | null;
    openai_api_key: string | null;
    gemini_api_key: string | null;
    perplexity_api_key: string | null;
    xai_api_key: string | null;
    base_url: string | null;
    model: string;
  };
}

let config: WaveConfig | null = null;
let configPath: string | null = null;

export function loadConfig(cfgPath?: string): WaveConfig {
  const resolvedPath = path.resolve(cfgPath ?? path.join(process.cwd(), 'config.yaml'));
  configPath = resolvedPath;
  const configDir = path.dirname(resolvedPath);
  const defaults = buildDefaults(configDir);

  if (!fs.existsSync(resolvedPath)) {
    config = defaults;
    return config;
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  const parsed = yaml.load(raw) as Partial<WaveConfig> | null;

  const merged = deepMerge(structuredClone(defaults) as unknown as Obj, (parsed ?? {}) as Obj) as unknown as WaveConfig;
  config = normalizeConfigPaths(merged, configDir);
  validateConfig(config);
  return config;
}

/**
 * Validate critical filesystem paths at startup. Fails fast with a clear,
 * actionable error rather than letting the daemon boot and crash on first
 * request. Currently checks that artifacts.storage is creatable and writable.
 */
const SHELL_BINS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh']);
/** `{lane}` may be one whole argument, or a refspec like `HEAD:{lane}`. */
const LANE_REFSPEC = /^\+?(?:HEAD|\{lane\}):\{lane\}$/;

function isShellArgv(argv: string[]): boolean {
  const bin = (argv[0] ?? '').split(/[/\\]/).pop() ?? '';
  if (!SHELL_BINS.has(bin)) return false;
  return argv.slice(1).some((arg) => arg === '-c' || arg === '-lc' || /^-[a-zA-Z]*c$/.test(arg));
}

function validateLanePlaceholder(name: string, argv: string[]): void {
  if (!argv.some((arg) => arg.includes('{lane}'))) return;
  if (isShellArgv(argv)) throw new Error(`${name} must not pass {lane} through a shell`);
  for (const arg of argv) {
    if (!arg.includes('{lane}')) continue;
    if (arg === '{lane}' || LANE_REFSPEC.test(arg)) continue;
    throw new Error(`${name} must use {lane} as its own argument or as a HEAD:{lane} refspec`);
  }
}

function validateArgvTemplate(name: string, argv: string[] | undefined, placeholder: string): void {
  if (argv === undefined) return;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string' || !a.trim() || a.length > 200)) {
    throw new Error(`${name} must be a non-empty list of arguments`);
  }
  if (!argv.some((a) => a.includes(placeholder))) throw new Error(`${name} must include ${placeholder}`);
  validateLanePlaceholder(name, argv);
}

function validateArgvList(name: string, argv: string[] | undefined): void {
  if (argv === undefined) return;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string' || !a.trim() || a.length > 200)) {
    throw new Error(`${name} must be a non-empty list of arguments`);
  }
}

const SUITE_NAME = /^[a-z0-9][a-z0-9._+-]{0,40}$/;

const AGENT_HANDLE = /^[A-Za-z][\w.-]{0,63}$/;

function validatePipeline(name: string, pipeline: ProjectConfig['pipeline']): void {
  if (pipeline === undefined) return;
  const flags = ['auto_freeze', 'auto_gate', 'auto_review', 'auto_stage', 'auto_merge_main'] as const;
  for (const flag of flags) {
    if (pipeline[flag] !== undefined && typeof pipeline[flag] !== 'boolean') {
      throw new Error(`projects.${name}.pipeline.${flag} must be a boolean`);
    }
  }
  // Quick check and gate run in a checkout of the exact SHA (the author's worktree, or a
  // detached checkout WaveCode makes), with WAVECODE_SHA / WAVECODE_LANE / COUNTIX_REMOTE_TEST_WHO
  // in the environment, so a tool that tests HEAD needs no placeholder.
  validateArgvList(`projects.${name}.pipeline.quick_check_command`, pipeline.quick_check_command);
  validateLanePlaceholder(`projects.${name}.pipeline.quick_check_command`, pipeline.quick_check_command ?? []);
  validateArgvList(`projects.${name}.pipeline.gate_command`, pipeline.gate_command);
  validateLanePlaceholder(`projects.${name}.pipeline.gate_command`, pipeline.gate_command ?? []);
  validateArgvTemplate(`projects.${name}.pipeline.push_command`, pipeline.push_command, '{lane}');
  for (const flag of ['gate_with_quick'] as const) {
    if (pipeline[flag] !== undefined && typeof pipeline[flag] !== 'boolean') {
      throw new Error(`projects.${name}.pipeline.${flag} must be a boolean`);
    }
  }
  for (const [key, max] of [['gate_timeout_min', 24 * 60], ['quick_check_timeout_min', 24 * 60], ['max_lane_files', 10_000]] as const) {
    const value = pipeline[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max)) {
      throw new Error(`projects.${name}.pipeline.${key} must be a whole number from 0 to ${max}`);
    }
  }
  if (pipeline.gate_max_inflight !== undefined && (typeof pipeline.gate_max_inflight !== 'number' || !Number.isInteger(pipeline.gate_max_inflight) || pipeline.gate_max_inflight < 1 || pipeline.gate_max_inflight > 50)) {
    throw new Error(`projects.${name}.pipeline.gate_max_inflight must be a whole number from 1 to 50`);
  }
  if (pipeline.reviewer_allow !== undefined && (!Array.isArray(pipeline.reviewer_allow) || pipeline.reviewer_allow.some((s) => typeof s !== 'string' || !AGENT_HANDLE.test(s)))) {
    throw new Error(`projects.${name}.pipeline.reviewer_allow must be a list of agent names or aliases`);
  }
  if (pipeline.service_profiles !== undefined && (!Array.isArray(pipeline.service_profiles) || pipeline.service_profiles.some((s) => typeof s !== 'string' || !/^[A-Za-z0-9][\w.-]{0,63}$/.test(s)))) {
    throw new Error(`projects.${name}.pipeline.service_profiles must be a list of profile names`);
  }
  if (pipeline.freeze_dir !== undefined && (typeof pipeline.freeze_dir !== 'string' || !pipeline.freeze_dir.trim() || pipeline.freeze_dir.includes('..'))) {
    throw new Error(`projects.${name}.pipeline.freeze_dir must be a directory path`);
  }
  if (pipeline.review_deny !== undefined && (!Array.isArray(pipeline.review_deny) || pipeline.review_deny.some((s) => typeof s !== 'string' || !AGENT_HANDLE.test(s)))) {
    throw new Error(`projects.${name}.pipeline.review_deny must be a list of agent names`);
  }
  if (pipeline.agent_deny !== undefined && (!Array.isArray(pipeline.agent_deny) || pipeline.agent_deny.some((s) => typeof s !== 'string' || !AGENT_HANDLE.test(s)))) {
    throw new Error(`projects.${name}.pipeline.agent_deny must be a list of agent names or aliases`);
  }
  if (pipeline.lane_deny !== undefined && (!Array.isArray(pipeline.lane_deny) || pipeline.lane_deny.some((s) => typeof s !== 'string' || !s.trim() || s.length > 80 || s.includes('..')))) {
    throw new Error(`projects.${name}.pipeline.lane_deny must be a list of globs`);
  }
  if (pipeline.review_routes !== undefined) {
    if (typeof pipeline.review_routes !== 'object' || pipeline.review_routes === null || Array.isArray(pipeline.review_routes)) {
      throw new Error(`projects.${name}.pipeline.review_routes must be an author-to-reviewer map`);
    }
    for (const [author, reviewer] of Object.entries(pipeline.review_routes)) {
      if (!AGENT_HANDLE.test(author) || typeof reviewer !== 'string' || !AGENT_HANDLE.test(reviewer)) {
        throw new Error(`projects.${name}.pipeline.review_routes entries must be agent names`);
      }
    }
  }
  validateNamedListMap(`projects.${name}.pipeline.reviewer_prefer`, pipeline.reviewer_prefer, /^[A-Za-z][A-Za-z0-9]{0,20}$/, 'vendor names');
  validateNamedListMap(`projects.${name}.pipeline.reviewer_pool_by_author_glob`, pipeline.reviewer_pool_by_author_glob, null, 'author globs');
  if (pipeline.review_reassign_minutes !== undefined) {
    const minutes = pipeline.review_reassign_minutes;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
      throw new Error(`projects.${name}.pipeline.review_reassign_minutes must be a number of minutes from 0 to 1440`);
    }
  }
  validateMergeQueue(name, pipeline.merge_queue);
}

function validateMergeQueue(name: string, mq: MergeQueueConfig | undefined): void {
  if (mq === undefined) return;
  const at = `projects.${name}.pipeline.merge_queue`;
  if (typeof mq !== 'object' || mq === null || Array.isArray(mq)) throw new Error(`${at} must be a map`);
  for (const flag of ['enabled', 'require_pr'] as const) {
    if (mq[flag] !== undefined && typeof mq[flag] !== 'boolean') throw new Error(`${at}.${flag} must be a boolean`);
  }
  if (mq.ask_paths !== undefined && (!Array.isArray(mq.ask_paths) || mq.ask_paths.some((p) => typeof p !== 'string' || !p.trim() || p.length > 200 || p.includes('..') || p.startsWith('/')))) {
    throw new Error(`${at}.ask_paths must be a list of relative path globs`);
  }
  if (mq.ask_tier !== undefined && !['label', 'auto'].includes(mq.ask_tier as string)) {
    throw new Error(`${at}.ask_tier must be label or auto`);
  }
  if (mq.default_tier !== undefined && !['ship', 'show', 'ask'].includes(mq.default_tier as string)) {
    throw new Error(`${at}.default_tier must be ship, show or ask`);
  }
  validateArgvList(`${at}.version_command`, mq.version_command);
  validateArgvList(`${at}.gate_command`, mq.gate_command);
  validateArgvList(`${at}.pr_list_command`, mq.pr_list_command);
  if (mq.maestro_log !== undefined && (typeof mq.maestro_log !== 'string' || !mq.maestro_log.trim() || mq.maestro_log.includes('..') || !/\.(log|txt|md)$/.test(mq.maestro_log))) {
    throw new Error(`${at}.maestro_log must be a .log, .txt or .md file path`);
  }
  if (mq.gate_timeout_min !== undefined && (typeof mq.gate_timeout_min !== 'number' || !Number.isInteger(mq.gate_timeout_min) || mq.gate_timeout_min < 1 || mq.gate_timeout_min > 1440)) {
    throw new Error(`${at}.gate_timeout_min must be a whole number of minutes from 1 to 1440`);
  }
  const globList = (v: unknown) => Array.isArray(v) && v.every((g) => typeof g === 'string' && g.trim() && g.length <= 80 && !g.includes('..'));
  if (mq.deny_lanes !== undefined && !globList(mq.deny_lanes)) throw new Error(`${at}.deny_lanes must be a list of branch globs`);
  if (mq.stall_minutes !== undefined && (typeof mq.stall_minutes !== 'number' || !Number.isInteger(mq.stall_minutes) || mq.stall_minutes < 5 || mq.stall_minutes > 1440)) {
    throw new Error(`${at}.stall_minutes must be a whole number of minutes from 5 to 1440`);
  }
  if (mq.stall_dir !== undefined && (typeof mq.stall_dir !== 'string' || !mq.stall_dir.trim() || mq.stall_dir.includes('..'))) throw new Error(`${at}.stall_dir must be a directory path`);
  if (mq.github !== undefined) {
    const gh = mq.github;
    if (typeof gh !== 'object' || gh === null || Array.isArray(gh)) throw new Error(`${at}.github must be a map`);
    if (typeof gh.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(gh.repo)) throw new Error(`${at}.github.repo must be owner/name`);
    if (gh.token_file !== undefined && (typeof gh.token_file !== 'string' || !gh.token_file.trim() || gh.token_file.includes('..'))) throw new Error(`${at}.github.token_file must be a file path`);
    if (gh.ok_label !== undefined && (typeof gh.ok_label !== 'string' || !gh.ok_label.trim() || gh.ok_label.length > 60)) throw new Error(`${at}.github.ok_label must be a label name`);
    if (gh.hold_labels !== undefined && !globList(gh.hold_labels)) throw new Error(`${at}.github.hold_labels must be a list of label names`);
  }
}

function validateNamedListMap(
  label: string,
  value: Record<string, string[]> | undefined,
  keyRe: RegExp | null,
  keyWhat: string,
): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a map of ${keyWhat} to agent names`);
  }
  for (const [key, names] of Object.entries(value)) {
    const globOk = key.trim().length > 0 && key.length <= 80 && !key.includes('..');
    if (keyRe ? !keyRe.test(key) : !globOk) {
      throw new Error(`${label} keys must be ${keyWhat}`);
    }
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || !AGENT_HANDLE.test(n))) {
      throw new Error(`${label} values must be lists of agent names`);
    }
  }
}

const PREREQ_ID = /^[\w.><=!+-]{1,80}$/;
const COMPARE_OPS = new Set(['>=', '>', '==', '<=', '<', '!=']);

function validatePrereqChecks(name: string, checks: ProjectConfig['prereq_checks']): void {
  if (checks === undefined) return;
  if (typeof checks !== 'object' || checks === null || Array.isArray(checks)) {
    throw new Error(`projects.${name}.prereq_checks must be a map of id to check`);
  }
  for (const [id, spec] of Object.entries(checks)) {
    if (!PREREQ_ID.test(id)) throw new Error(`projects.${name}.prereq_checks key '${id}' is not a prereq id`);
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`projects.${name}.prereq_checks.${id} must be a check`);
    }
    validateArgvList(`projects.${name}.prereq_checks.${id}.command`, spec.command);
    if (!spec.command?.length) throw new Error(`projects.${name}.prereq_checks.${id}.command must be a non-empty list of arguments`);
    if (spec.command.some((part) => part.includes('..'))) {
      throw new Error(`projects.${name}.prereq_checks.${id}.command must not contain '..'`);
    }
    const type = spec.type ?? 'exit';
    if (type !== 'exit' && type !== 'ndjson') {
      throw new Error(`projects.${name}.prereq_checks.${id}.type must be exit or ndjson`);
    }
    if (type === 'ndjson') {
      if (typeof spec.field !== 'string' || !spec.field.trim()) {
        throw new Error(`projects.${name}.prereq_checks.${id}.field is required for ndjson`);
      }
      if (typeof spec.compare !== 'string' || !COMPARE_OPS.has(spec.compare)) {
        throw new Error(`projects.${name}.prereq_checks.${id}.compare must be one of >= > == <= < !=`);
      }
      if (typeof spec.value !== 'number' && typeof spec.value !== 'string') {
        throw new Error(`projects.${name}.prereq_checks.${id}.value is required for ndjson`);
      }
    }
  }
}

function validateSuiteNames(name: string, suites: string[] | undefined): void {
  if (suites === undefined) return;
  if (!Array.isArray(suites) || suites.length === 0 || suites.some((s) => typeof s !== 'string' || !SUITE_NAME.test(s))) {
    throw new Error(`${name} must be a list of suite names (letters, digits, . _ + -)`);
  }
}

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const SAFE_REL_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const DEVELOPER_NAME = /^[\p{L}][\p{L}0-9 .'_-]{0,40}$/u;
const DEVELOPER_USER = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function validateSlack(s: SlackConfig | undefined): void {
  if (s === undefined) return;
  if (typeof s !== 'object' || s === null || Array.isArray(s)) throw new Error('slack must be a map');
  const filePath = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && !v.includes('..');
  if (!filePath(s.app_token_file)) throw new Error('slack.app_token_file must be a file path');
  if (!filePath(s.bot_token_file)) throw new Error('slack.bot_token_file must be a file path');
  if (/^x(app|oxb|oxp)-/.test(s.app_token_file) || /^x(app|oxb|oxp)-/.test(s.bot_token_file)) throw new Error('slack.*_token_file must be a file path, never the token itself');
  const seat = (v: unknown): v is string => typeof v === 'string' && /^[\w.-]{1,64}$/.test(v);
  if (s.dm_seat !== undefined && !seat(s.dm_seat)) throw new Error('slack.dm_seat must be an agent name');
  if (s.routes !== undefined) {
    if (!Array.isArray(s.routes)) throw new Error('slack.routes must be a list');
    for (const r of s.routes) {
      if (typeof r !== 'object' || r === null || !/^[A-Z0-9]{6,20}$/.test(String(r.channel))) throw new Error('slack.routes[].channel must be a Slack channel ID (C…)');
      if (!seat(r.seat)) throw new Error(`slack.routes[${r.channel}].seat must be an agent name`);
      if (r.mode !== undefined && r.mode !== 'mention' && r.mode !== 'all') throw new Error(`slack.routes[${r.channel}].mode must be mention or all`);
      if (r.name !== undefined && (typeof r.name !== 'string' || !/^[\w-]{1,40}$/.test(r.name))) throw new Error(`slack.routes[${r.channel}].name must be a short channel name`);
      if (r.users !== undefined && (!Array.isArray(r.users) || r.users.length === 0 || r.users.some((u) => typeof u !== 'string' || !/^[UW][A-Z0-9]{5,20}$/.test(u)))) throw new Error(`slack.routes[${r.channel}].users must be a list of Slack user IDs`);
    }
  }
  if (s.users !== undefined) {
    if (typeof s.users !== 'object' || s.users === null || Array.isArray(s.users)) throw new Error('slack.users must be a map of Slack user ID → WaveCode user name');
    for (const [id, name] of Object.entries(s.users)) {
      if (!/^[UW][A-Z0-9]{5,20}$/.test(id) || typeof name !== 'string' || !name.trim()) throw new Error(`slack.users.${id} must map a Slack user ID (U…) to a WaveCode user name`);
    }
  }
  if (s.notify_channel !== undefined && !/^[A-Z0-9]{6,20}$/.test(s.notify_channel)) throw new Error('slack.notify_channel must be a Slack channel ID');
  if (s.reply_timeout_s !== undefined && (typeof s.reply_timeout_s !== 'number' || !(s.reply_timeout_s >= 30) || !(s.reply_timeout_s <= 3600))) throw new Error('slack.reply_timeout_s must be 30 to 3600 seconds');
  if (!s.dm_seat && !(s.routes ?? []).length) throw new Error('slack needs dm_seat or at least one route');
}

function validateDevelopers(list: DeveloperConfig[] | undefined): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) throw new Error('developers must be a list');
  for (const [i, dev] of list.entries()) {
    const at = `developers[${i}]`;
    if (!dev || typeof dev !== 'object' || Array.isArray(dev)) throw new Error(`${at} must be a developer`);
    if (typeof dev.name !== 'string' || !DEVELOPER_NAME.test(dev.name.trim())) {
      throw new Error(`${at}.name must be a person's name`);
    }
    const users = dev.users ?? [];
    const tokens = dev.tokens ?? [];
    if (!Array.isArray(users) || users.some((u) => typeof u !== 'string' || !DEVELOPER_USER.test(u))) {
      throw new Error(`${at}.users must be a list of user names`);
    }
    if (!Array.isArray(tokens) || tokens.some((t) => typeof t !== 'string' || !t.trim() || /\s/.test(t) || t.length > 200)) {
      throw new Error(`${at}.tokens must be a list of bearer tokens`);
    }
    if (users.length === 0 && tokens.length === 0) {
      throw new Error(`${at} needs users or tokens`);
    }
    if (!Array.isArray(dev.lanes) || dev.lanes.length === 0 || dev.lanes.some((s) => typeof s !== 'string' || !s.trim() || s.length > 80 || s.includes('..'))) {
      throw new Error(`${at}.lanes must be a list of globs`);
    }
  }
}

export function validateConfig(cfg: WaveConfig): void {
  validateSlack(cfg.slack);
  if (cfg.usage?.alert_used_pct !== undefined && (typeof cfg.usage.alert_used_pct !== 'number' || !(cfg.usage.alert_used_pct >= 0) || !(cfg.usage.alert_used_pct <= 100))) {
    throw new Error('usage.alert_used_pct must be 0 (off) to 100');
  }
  const profileErrors = validateProfilesConfig(cfg);
  if (profileErrors.length > 0) {
    throw new Error(`Invalid credential profile config:\n  ${profileErrors.join('\n  ')}`);
  }
  if (cfg.diagrams?.kroki_url && !/^https?:\/\/[^\s/]+(?::\d+)?\/?$/.test(cfg.diagrams.kroki_url)) {
    throw new Error('diagrams.kroki_url must be an http(s) origin like http://127.0.0.1:8000');
  }
  if (cfg.product_desk?.url && !/^https?:\/\/[^\s]+$/.test(cfg.product_desk.url)) throw new Error('product_desk.url must be an http(s) URL');
  if (cfg.test_portal?.url && !/^https?:\/\/[^\s/]+(?::\d+)?\/?$/.test(cfg.test_portal.url)) throw new Error('test_portal.url must be an http(s) origin like http://countix-testing.tailf32df0.ts.net:8088');
  if (cfg.test_portal?.poll_s !== undefined && (typeof cfg.test_portal.poll_s !== 'number' || !(cfg.test_portal.poll_s >= 5))) throw new Error('test_portal.poll_s must be a number >= 5');
  if (cfg.terminal_stream?.max_viewers !== undefined && (typeof cfg.terminal_stream.max_viewers !== 'number' || !(cfg.terminal_stream.max_viewers >= 1))) throw new Error('terminal_stream.max_viewers must be a number >= 1');
  if (cfg.overlord) {
    const o = cfg.overlord;
    if (o.model !== undefined && (typeof o.model !== 'string' || !/^[\w.-]{3,64}$/.test(o.model))) throw new Error('overlord.model must be a model id like claude-sonnet-5-5');
    for (const k of ['heartbeat_min', 'max_wakes_per_hour', 'debounce_s'] as const) {
      if (o[k] !== undefined && (typeof o[k] !== 'number' || !(o[k]! >= 0))) throw new Error(`overlord.${k} must be a number >= 0`);
    }
  }
  if (cfg.events) {
    for (const k of ['short_hours', 'retention_days'] as const) {
      if (cfg.events[k] !== undefined && (typeof cfg.events[k] !== 'number' || !(cfg.events[k]! >= 0))) throw new Error(`events.${k} must be a number >= 0`);
    }
    if (cfg.events.short_lived_types !== undefined && (!Array.isArray(cfg.events.short_lived_types) || !cfg.events.short_lived_types.every((t) => typeof t === 'string' && /^[\w.]+$/.test(t)))) {
      throw new Error('events.short_lived_types must be a list of event type names');
    }
  }
  if (cfg.releases?.deploy_agent != null && (typeof cfg.releases.deploy_agent !== 'string' || !/^@?[\w.-]{1,64}$/.test(cfg.releases.deploy_agent))) {
    throw new Error('releases.deploy_agent must be an agent alias, name or id');
  }
  if (cfg.releases?.main_only !== undefined && typeof cfg.releases.main_only !== 'boolean') throw new Error('releases.main_only must be a boolean');
  if (cfg.releases?.production_approvers !== undefined) {
    const list = cfg.releases.production_approvers;
    if (!Array.isArray(list) || list.some((n) => typeof n !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(n))) {
      throw new Error('releases.production_approvers must be a list of user names (an empty list refuses every peer production request)');
    }
  }
  validateArgvTemplate('releases.staging_command', cfg.releases?.staging_command, '{sha}');
  validateArgvTemplate('releases.staging_watch_command', cfg.releases?.staging_watch_command, '{deploy_id}');
  validateArgvTemplate('releases.production_command', cfg.releases?.production_command, '{sha}');
  validateArgvList('releases.staging_health_command', cfg.releases?.staging_health_command);
  validateArgvList('releases.prod_health_command', cfg.releases?.prod_health_command);
  if (cfg.releases?.slack_go_window_min !== undefined && (typeof cfg.releases.slack_go_window_min !== 'number' || !(cfg.releases.slack_go_window_min > 0))) {
    throw new Error('releases.slack_go_window_min must be a positive number of minutes');
  }
  if (cfg.deliveries?.notify !== undefined && (!Array.isArray(cfg.deliveries.notify) || cfg.deliveries.notify.some((s) => typeof s !== 'string' || !s.trim()))) {
    throw new Error('deliveries.notify must be a list of agent aliases or names');
  }
  if (cfg.deliveries?.auto_track !== undefined && typeof cfg.deliveries.auto_track !== 'boolean') {
    throw new Error('deliveries.auto_track must be true or false');
  }
  if (cfg.autonomy?.fresh_context !== undefined && typeof cfg.autonomy.fresh_context !== 'boolean') {
    throw new Error('autonomy.fresh_context must be true or false');
  }
  if (cfg.deliveries?.budgets_min !== undefined) {
    const b = cfg.deliveries.budgets_min;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.values(b).some((v) => typeof v !== 'number' || !(v > 0))) {
      throw new Error('deliveries.budgets_min must map stage names to minutes > 0');
    }
  }
  if (cfg.artifacts.fixture_inbox !== undefined) {
    if (!Array.isArray(cfg.artifacts.fixture_inbox) || cfg.artifacts.fixture_inbox.some((d) => typeof d !== 'string' || !d.trim())) {
      throw new Error('artifacts.fixture_inbox must be a list of directory paths');
    }
  }
  if (cfg.review.freeze_inbox !== undefined) {
    if (!Array.isArray(cfg.review.freeze_inbox) || cfg.review.freeze_inbox.some((d) => typeof d !== 'string' || !d.trim())) {
      throw new Error('review.freeze_inbox must be a list of directory paths');
    }
  }
  if (cfg.review.min_capacity_pct !== undefined) {
    const pct = cfg.review.min_capacity_pct;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new Error('review.min_capacity_pct must be a percentage from 0 to 100');
    }
  }
  if (cfg.review.first_pass !== undefined) {
    const fp = cfg.review.first_pass;
    if (typeof fp !== 'object' || fp === null || Array.isArray(fp)) throw new Error('review.first_pass must be a map');
    if (fp.enabled !== undefined && typeof fp.enabled !== 'boolean') throw new Error('review.first_pass.enabled must be a boolean');
    if (fp.seats !== undefined && (!Array.isArray(fp.seats) || fp.seats.some((s) => typeof s !== 'string' || !AGENT_HANDLE.test(s)))) {
      throw new Error('review.first_pass.seats must be a list of agent names or aliases');
    }
    if (fp.enabled && !(fp.seats?.length)) throw new Error('review.first_pass.seats must name at least one seat when first_pass is enabled');
    if (fp.dir !== undefined && (typeof fp.dir !== 'string' || !fp.dir.trim() || fp.dir.includes('..'))) throw new Error('review.first_pass.dir must be a directory path');
    if (fp.timeout_min !== undefined && (typeof fp.timeout_min !== 'number' || !Number.isInteger(fp.timeout_min) || fp.timeout_min < 1 || fp.timeout_min > 1440)) {
      throw new Error('review.first_pass.timeout_min must be a number of minutes from 1 to 1440');
    }
  }
  validateDevelopers(cfg.developers);
  for (const [name, project] of Object.entries(cfg.projects ?? {})) {
    if (project.main_remote !== undefined && !SAFE_REF.test(project.main_remote)) {
      throw new Error(`projects.${name}.main_remote must be a remote name`);
    }
    if (project.main_branch !== undefined && !SAFE_REF.test(project.main_branch)) {
      throw new Error(`projects.${name}.main_branch must be a branch name`);
    }
    if (project.lane_glob !== undefined && (typeof project.lane_glob !== 'string' || !project.lane_glob.trim())) {
      throw new Error(`projects.${name}.lane_glob must be a glob`);
    }
    if (project.protected_paths !== undefined) {
      if (!Array.isArray(project.protected_paths) || project.protected_paths.some((p) => typeof p !== 'string' || !SAFE_REL_PATH.test(p) || p.includes('..'))) {
        throw new Error(`projects.${name}.protected_paths must be a list of relative paths`);
      }
    }
    if (project.migrations_dir !== undefined && (typeof project.migrations_dir !== 'string' || !SAFE_REL_PATH.test(project.migrations_dir) || project.migrations_dir.includes('..'))) {
      throw new Error(`projects.${name}.migrations_dir must be a relative path`);
    }
    if (project.before_freeze_tip !== undefined && (typeof project.before_freeze_tip !== 'string' || project.before_freeze_tip.length > 400)) {
      throw new Error(`projects.${name}.before_freeze_tip must be a short string`);
    }
    if (project.tests) {
      validateArgvList(`projects.${name}.tests.status_command`, project.tests.status_command);
      if (project.tests.status_command && !project.tests.status_command.some((a) => a.includes('{lane}') || a.includes('{sha}'))) {
        throw new Error(`projects.${name}.tests.status_command must include {lane} or {sha}`);
      }
      validateArgvList(`projects.${name}.tests.history_command`, project.tests.history_command);
      if (project.tests.history_command && !project.tests.history_command.some((a) => a.includes('{lane}') || a.includes('{sha}'))) {
        throw new Error(`projects.${name}.tests.history_command must include {lane} or {sha}`);
      }
      validateArgvTemplate(`projects.${name}.tests.log_command`, project.tests.log_command, '{id}');
      validateSuiteNames(`projects.${name}.tests.quick_suites`, project.tests.quick_suites);
      validateSuiteNames(`projects.${name}.tests.full_suites`, project.tests.full_suites);
    }
    validatePipeline(name, project.pipeline);
    validatePrereqChecks(name, project.prereq_checks);
    if (project.release_peer !== undefined) {
      const m = /^([a-z][a-z0-9_-]*)\/(@?[\w.-]+)$/.exec(project.release_peer);
      if (!m) throw new Error(`projects.${name}.release_peer must look like peer/agent (e.g. deploy/fable)`);
      if (!cfg.peers?.[m[1]]) throw new Error(`projects.${name}.release_peer names unknown peer '${m[1]}' (add it under peers:)`);
    }
  }
  for (const [name, peer] of Object.entries(cfg.peers ?? {})) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`peers.${name}: name must be lowercase letters, digits, - or _`);
    if (!peer || typeof peer.url !== 'string' || !/^https?:\/\/[^\s/]+(?::\d+)?\/?$/.test(peer.url)) {
      throw new Error(`peers.${name}.url must be an http(s) origin like http://100.1.2.3:3777`);
    }
    if (typeof peer.token !== 'string' || peer.token.trim().length < 16) throw new Error(`peers.${name}.token is required`);
    if (peer.agents !== undefined && (!Array.isArray(peer.agents) || peer.agents.some((a) => typeof a !== 'string' || !a.trim()))) {
      throw new Error(`peers.${name}.agents must be a list of agent handles`);
    }
  }

  const storageDir = cfg.artifacts.storage;

  try {
    fs.mkdirSync(storageDir, { recursive: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new Error(
      `Cannot create artifact storage directory '${storageDir}' (${err.code ?? 'unknown'}): ${err.message}. ` +
      `Update artifacts.storage in config.yaml to a writable path under your home directory.`,
    );
  }

  try {
    fs.accessSync(storageDir, fs.constants.W_OK);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new Error(
      `Artifact storage directory '${storageDir}' exists but is not writable (${err.code ?? 'unknown'}): ${err.message}. ` +
      `Fix permissions or update artifacts.storage in config.yaml.`,
    );
  }
}

export function getConfig(): WaveConfig {
  if (!config) throw new Error('Config not loaded. Call loadConfig() first.');
  return config;
}

/**
 * Get the Anthropic API key — from config first, then env var fallback.
 */
export function getAnthropicApiKey(): string | null {
  const cfg = getConfig();
  return cfg.llm.anthropic_api_key || cfg.llm.api_key || process.env.ANTHROPIC_API_KEY || null;
}

export function getOpenAIApiKey(): string | null {
  const cfg = getConfig();
  return cfg.llm.openai_api_key || process.env.OPENAI_API_KEY || null;
}

export function getGeminiApiKey(): string | null {
  const cfg = getConfig();
  return cfg.llm.gemini_api_key || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
}

export function getPerplexityApiKey(): string | null {
  const cfg = getConfig();
  return cfg.llm.perplexity_api_key || process.env.PERPLEXITY_API_KEY || null;
}

export function getXAIApiKey(): string | null {
  const cfg = getConfig();
  return cfg.llm.xai_api_key || process.env.XAI_API_KEY || null;
}

/**
 * Which research providers have API keys configured.
 * Returns booleans — never expose the keys themselves.
 */
export function getProviderStatus(): Record<string, boolean> {
  return {
    anthropic: !!getAnthropicApiKey(),
    openai: !!getOpenAIApiKey(),
    gemini: !!getGeminiApiKey(),
    perplexity: !!getPerplexityApiKey(),
    xai: !!getXAIApiKey(),
  };
}

/** Top-level keys that are allowed to be updated via the API. */
const ALLOWED_CONFIG_KEYS = new Set<keyof WaveConfig>([
  'server', 'autonomy', 'llm', 'notifications', 'artifacts', 'review',
]);

/**
 * Update config in memory and persist to config.yaml.
 * Only allows known top-level keys to prevent injection of auth/sandbox overrides.
 */
export function updateConfig(updates: Partial<WaveConfig>): WaveConfig {
  if (!config) throw new Error('Config not loaded.');

  // Filter to allowed keys only — blocks auth, sandbox, runtimes overrides from API
  const safeUpdates: Partial<WaveConfig> = {};
  for (const key of Object.keys(updates) as (keyof WaveConfig)[]) {
    if (ALLOWED_CONFIG_KEYS.has(key)) {
      (safeUpdates as Obj)[key] = (updates as Obj)[key];
    }
  }

  // Deep merge into a clone first, then assign (atomic in-memory update)
  const merged = deepMerge(
    structuredClone(config) as unknown as Obj,
    safeUpdates as unknown as Obj,
  ) as unknown as WaveConfig;

  // Persist to file with restricted permissions (contains API keys)
  if (configPath) {
    const yamlStr = yaml.dump(merged, { indent: 2, lineWidth: 120 });
    fs.writeFileSync(configPath, yamlStr, { encoding: 'utf-8', mode: 0o600 });
    // Ensure permissions are correct even if file existed
    fs.chmodSync(configPath, 0o600);
  }

  // Only update in-memory config after successful file write
  config = merged;
  return config;
}

type Obj = Record<string, unknown>;

function buildDefaults(baseDir: string): WaveConfig {
  const dataRoot = path.join(baseDir, '.wavecode-data');

  return {
    server: { port: 3777, host: '0.0.0.0' },
    paths: {
      projects_root: '',
      worktrees_root: path.join(dataRoot, 'worktrees'),
      transcripts_root: path.join(dataRoot, 'transcripts'),
      teams_root: path.join(baseDir, 'teams'),
      guides_root: path.join(baseDir, 'guides'),
      templates_root: path.join(baseDir, 'templates'),
      rooms_root: path.join(dataRoot, 'rooms'),
    },
    autonomy: {
      auto_dispatch: true,
      auto_restart: true,
      hang_timeout_min: 10,
      hang_action: 'alert',
      max_task_retries: 2,
      verify_completion: false,
      fresh_context: true,
    },
    sandbox: { disable_git_push: true, restrict_network: true },
    runtimes: {
      'claude-code': {
        command: 'claude --dangerously-skip-permissions',
        idle_pattern: '\\$\\s*$',
        model_flag: '--model',
        resume_args: '--continue',
        env: { CLAUDE_CONFIG_DIR: '{profile_dir}/claude' },
        login_command: 'claude /login',
        credential_files: ['{profile_dir}/claude/.credentials.json'],
      },
      grok: {
        command: 'grok --always-approve',
        idle_pattern: '^>\\s*$',
        model_flag: '--model',
        input_mode: 'type',
        // No profile flag: HOME override for that process only (PATH preserved by `env`)
        env: { HOME: '{profile_dir}/grok-home' },
        login_command: 'grok',
        credential_files: ['{profile_dir}/grok-home/.grok/user-settings.json', '{profile_dir}/grok-home/.grok/auth.json'],
      },
      codex: {
        command: 'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust',
        idle_pattern: '^>\\s*$',
        model_flag: '-m',
        // Current Codex CLI (Rust): `-c model_reasoning_effort=xhigh`.
        // Injector concatenates without a space when the flag ends with `=`.
        effort_flag: '-c model_reasoning_effort=',
        resume_args: 'resume --last',
        env: { CODEX_HOME: '{profile_dir}/codex' },
        login_command: 'codex login',
        credential_files: ['{profile_dir}/codex/auth.json'],
      },
      aider: {
        command: 'aider --yes',
        idle_pattern: '^>\\s*$',
        model_flag: '--model',
      },
    },
    projects: {},
    profiles_root: path.join(dataRoot, 'profiles'),
    profiles: {},
    orchestrator_agent: null,
    peers: {},
    retro: { nightly: true, hour_utc: 3, window_days: 7 },
    auth: { method: 'token', fallback_token: null, trusted_proxies: [] },
    notifications: { web_push: false, ntfy_topic: null, telegram_bot_token: null, telegram_chat_id: null },
    artifacts: { storage: path.join(dataRoot, 'artifacts'), retention_days: 30 },
    review: {
      auto_review: false,
      default_reviewer: 'aider-deepseek',
      self_review: true,
      max_fix_loops: 2,
      require_pass_to_promote: false,
      gate_dependents_on_approval: false,
      auto_pick: true,
    },
    terminal_stream: {
      enabled: true,
      fifo_dir: path.join(dataRoot, 'terminal'),
      max_viewers: 20,
    },
    ops_lanes: {
      dir: DEFAULT_OPS_DIR,
      poll_s: DEFAULT_OPS_POLL_S,
      stale_min: DEFAULT_OPS_STALE_MIN,
      roles: [...DEFAULT_OPS_ROLES],
      receipts_root: DEFAULT_OPS_RECEIPTS,
      owners: [...DEFAULT_OPS_OWNERS],
    },
    developers: [],
    llm: {
      provider: 'anthropic',
      api_key: null,
      anthropic_api_key: null,
      anthropic_workspace_id: null,
      openai_api_key: null,
      gemini_api_key: null,
      perplexity_api_key: null,
      xai_api_key: null,
      base_url: null,
      model: 'claude-sonnet-4-20250514',
    },
  };
}

function normalizeConfigPaths(cfg: WaveConfig, baseDir: string): WaveConfig {
  const normalized = structuredClone(cfg);

  normalized.paths.projects_root = normalizePathSetting(normalized.paths.projects_root, baseDir, { allowEmpty: true });
  normalized.paths.worktrees_root = normalizePathSetting(normalized.paths.worktrees_root, baseDir);
  normalized.paths.transcripts_root = normalizePathSetting(normalized.paths.transcripts_root, baseDir);
  normalized.paths.teams_root = normalizePathSetting(normalized.paths.teams_root, baseDir);
  normalized.paths.guides_root = normalizePathSetting(normalized.paths.guides_root, baseDir);
  normalized.paths.templates_root = normalizePathSetting(normalized.paths.templates_root, baseDir);
  normalized.paths.rooms_root = normalizePathSetting(normalized.paths.rooms_root, baseDir);
  normalized.artifacts.storage = normalizePathSetting(normalized.artifacts.storage, baseDir);
  normalized.profiles_root = normalizePathSetting(normalized.profiles_root, baseDir);
  normalized.profiles = normalized.profiles ?? {};
  if (normalized.terminal_stream?.fifo_dir?.trim()) {
    normalized.terminal_stream.fifo_dir = normalizePathSetting(normalized.terminal_stream.fifo_dir.trim(), baseDir);
  }
  if (normalized.ops_lanes) {
    const dir = normalized.ops_lanes.dir?.trim() ?? '';
    normalized.ops_lanes.dir = dir ? normalizePathSetting(dir, baseDir) : '';
    const receipts = normalized.ops_lanes.receipts_root?.trim() ?? '';
    if (receipts) normalized.ops_lanes.receipts_root = normalizePathSetting(receipts, baseDir);
  }

  return normalized;
}

function normalizePathSetting(value: string, baseDir: string, opts: { allowEmpty?: boolean } = {}): string {
  if (!value) return opts.allowEmpty ? '' : baseDir;

  const expanded = expandHomeDir(value);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function expandHomeDir(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function deepMerge(target: Obj, source: Obj): Obj {
  for (const key of Object.keys(source)) {
    const targetVal = target[key];
    const sourceVal = source[key];
    if (
      targetVal && sourceVal &&
      typeof targetVal === 'object' && typeof sourceVal === 'object' &&
      !Array.isArray(targetVal) && !Array.isArray(sourceVal)
    ) {
      target[key] = deepMerge(targetVal as Obj, sourceVal as Obj);
    } else {
      target[key] = sourceVal;
    }
  }
  return target;
}
