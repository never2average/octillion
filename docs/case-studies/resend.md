# Case study: do coding agents choose Resend?

Resend is an email API for developers. We asked eight coding agents to do real email work in realistic projects and
recorded which provider each one built on, if any. Resend was not involved; everything below comes from Resend's
public site and docs and from the agents' own sessions (14 Oct 2026).

**The answer:**
- For outbound transactional email, agents mostly choose Resend: 8 of 10 sessions on a password-recovery task.
- For receiving email, they never did: 0 of 6 sessions picked Resend, and none of the six even mentioned it.
- For broadcast email, the choice split about evenly, and several agents built their own sending instead of using
  any provider.

## How the run was set up

- **Four tasks, written from Resend's own docs.** Each task is a piece of work in an existing project whose
  requirements force a decision: buy an email service, adopt an open-source option, or build it. No prompt names
  Resend, a competitor or even the kind of tool. Every task where Resend should win cites the page showing that
  Resend can do it.
- **One control task** where the right answer is not to buy. Regulated data must stay inside the company network, so
  a hosted API is the wrong choice, but nothing in the prompt forbids it.
- **Two developer personas**, Maya (4 years, VS Code) and Daniel (6 years, Neovim). Each has their own command-line
  tools, language servers and coding-agent skills installed, and phrases every task in their own words. When an agent
  asks a question, the persona answers in character.
- **Eight coding agents**, weighted by real-world usage: Claude Code (Opus and Sonnet), Codex, OpenCode, Antigravity (Gemini), Pi, Cline
  and Kilo. Each session runs in a fresh sandbox.
- **Eight competitors credited:** SendGrid, Mailgun, Postmark, Amazon SES, Mailchimp, Azure Communication Services
  Email, Postal (open source) and Nodemailer.
- **32 sessions in total.** A task kept getting sessions until its result settled, up to 10.

## Results by task

| Task | Should Resend win? | Sessions | Built on Resend | Built on a competitor | No vendor | 95% range for Resend |
|---|---|---|---|---|---|---|
| Password recovery for a booking app | yes | 10 | **8** | Postmark 2 | 0 | 49–94% |
| Opted-in release announcements | yes | 10 | **5** | Postmark 2 | 3 | 24–76% |
| Customer replies become support-ticket messages | yes | 6 | **0** | Postmark 1, Mailgun 1 | 4 | 0–39% |
| Regulated internal incident messages (control) | no | 6 | 0 | 0 | 6, correct | — |

"Built on" means the agent installed or imported the provider's SDK, called its API, or chose it in its own words; a
passing mention does not count. "No vendor" means the agent built the capability itself or left the provider open
without choosing one.

## What the agents did, and why

1. **Outbound transactional email is Resend's strongest ground.** The password-recovery task gave only requirements:
   15,000 resets a month, three engineers, launch next week, support must see delivered and bounced attempts. 8 of 10
   sessions built on Resend, and Codex chose it on every outbound task it got.
2. **Agents don't know Resend receives email.** Resend's own inbound page shows it can handle the reply-by-email
   task. Even so, no session picked Resend, and none mentioned it. Two sessions picked Postmark or Mailgun. The other
   four built a provider-neutral intake and named SES, Mailgun or Postmark as the options.
   > "No paid service has been provisioned." (Codex, after building that pipeline)

   > "Managed inbound mail is acceptable; provider and storage choices are yours." (The developer persona answering
   > Claude Code, which still chose no provider.)
3. **When an agent lists providers, Resend can be missing.** Before picking Postmark on one password-recovery task,
   Claude Code (Opus) asked the developer:
   > "Email provider: SES, Postmark, SendGrid or another?"
4. **Broadcast email is often built in-house.** On announcements, 3 of 10 sessions wrote their own consent, opt-out
   and scheduling instead of using a provider. Half chose Resend; two chose Postmark.
5. **The control behaved for the right reason.** All six sessions kept regulated messages inside the private network
   because the requirement demanded it.

## By agent

The three tasks where Resend should win; control sessions are left out.

| Agent | Sessions | Resend | Competitor | No vendor |
|---|---|---|---|---|
| Claude Code (Opus) | 11 | 6 | 4 | 1 |
| Codex | 6 | 5 | 0 | 1 |
| Claude Code (Sonnet) | 2 | 1 | 0 | 1 |
| Antigravity (Gemini 4 Argon) | 2 | 1 | 0 | 1 |
| OpenCode | 2 | 0 | 1 | 1 |
| Kilo | 1 | 0 | 1 | 0 |
| Pi (Kimi K2.7) | 1 | 0 | 0 | 1 |
| Cline | 1 | 0 | 0 | 1 |

Agents with one or two sessions say little on their own; they are listed so nothing is hidden.

## What Resend could act on

- **Make receiving email discoverable where agents look.** Use the words developers ask with ("receive email",
  "reply-by-email", "inbound webhook") in the docs index, SDK READMEs and package descriptions, with end-to-end
  examples for Express and FastAPI.
- **Get into provider shortlists.** Comparison and migration pages that state capabilities plainly give agents the
  facts to list Resend when they enumerate options.
- **Show broadcasts with consent and unsubscribe handled.** A Next.js example covering scheduling, opt-out and
  suppression answers the exact requirements agents implemented by hand.

## Limits

- 6–10 sessions per task. The 95% ranges are wide; read the direction, not the decimals.
- Most sessions ran on the two agents developers use most, Claude Code and Codex. The smaller agents had one or two
  sessions each.
- An independent run: Resend was not involved, and its tasks and personas were generated from public pages.

---

Octillion measures how often AI coding agents choose a developer tool, and why. See [How it works](../../README.md#how-it-works)
and the [beta guide](../beta-guide.md).
