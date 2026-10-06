# Welcome email for a new developer (template)

Replace the three placeholders: NAME, TOKEN (from `/home/wave/wavecode-ops.md`, section `## user NAME`), and the Tailscale invite.

---

Subject: Your access to the Countix development box (WaveCode)

Hi NAME,

welcome aboard. Our coding agents (Claude Code, Codex, Grok) run on a shared development server, and we steer them from one web UI called WaveCode. You don't need to install anything on the server; you need three things.

**1. Join our private network (Tailscale).**
Accept the Tailscale invite you'll get in a separate email, install Tailscale on your laptop and phone, and sign in. The development box is only reachable from inside that network.

**2. Open WaveCode.**
http://countix-dev:3777 — paste the access token I'll send you in a separate message (treat it like a password; it is yours alone). You'll land in the Command Center: a thread with every agent on the left.

**3. Connect your own subscriptions, once per CLI you use.**
Agents on this box bill the subscription of the person who owns them, so your agents run on your Claude and/or ChatGPT plan, not on anyone else's. In WaveCode: Settings → Profiles → your name → "Log in" next to Claude Code or Codex. A login pane opens; follow the link or device code it shows, sign in with your account, done. (If you prefer the terminal: `ssh NAME@188.40.85.171` and `wave-login claude-code` / `wave-login codex`; send me your SSH public key first.)

**Then, in WaveCode:**
- Settings → My seat → Create. That's your personal PM agent (`pm-NAME`). Ask it anything in the thread: "who is free?", "what is @codex1 doing?", "status". It answers from the live state.
- Dashboard → Spawn: give an agent a name, pick Claude Code or Codex, repo `/home/wave/repos/wavepulse`. It gets its own git worktree and branch (`wc-<name>`). You can spawn as many as your plan allows.
- Talk to agents with @: `@yourbuilder implement the VAT rounding fix from SPEC.md, run the tests, report`. One task per message works best.
- When an agent finishes, another agent (a different vendor, picked automatically) reviews the diff. You get a verdict in the thread; Promote merges the lane branch and pushes it.
- `#reserve @agent 2h` keeps an agent for yourself; `#review #12 @opus` names a reviewer; `#ask deploy/fable …` asks the deploy box a question.
- Paths agents mention are links: click to read the file.

**Rules that matter:**
- Agents work only on their own branch and never touch `main`; the review and Promote flow is how code lands.
- Never paste production credentials or customer data anywhere on this box.
- The project spec, decisions and templates live in the project room (Room tab). Read SPEC.md before giving bigger tasks.
- If something looks stuck, say so in the thread; `#status` gives the overview.

Questions: just write me, or ask your seat in the thread first — it knows the setup.

Denis
