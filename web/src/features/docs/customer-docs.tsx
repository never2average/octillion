// /app/docs: the customer guide, opened from the Docs button at the bottom of the sidebar. Every statement follows the
// product as built: the MCP tools are the customer server's registrations (src/server.ts createServer, and its slash
// commands in registerPrompts), the connection flow is the Setup & training page (features/portal/setup.tsx), the
// Pick rate page is features/portal/pick-rate.tsx + visibility.tsx, Billing is features/portal/billing.tsx. Library
// personas and tasks are Octillion's: this page names the concepts, never their content.
import Link from 'next/link';
import PageContainer from '@/components/layout/page-container';
import { Markdown, anchorId } from '@/components/markdown';

const GUIDE = `
## What Octillion does

When a developer asks an AI coding agent to "add a database" or "send a welcome email", the agent picks a tool. Octillion
measures whether it picks **yours**.

It runs real coding agents (Claude Code, Codex, Cursor and others) as sandboxed sub-agents on realistic programming
tasks that never name your product, mixed in proportion to how much developers really use each agent. Each session is
scored from its transcript: did the agent build on your product, on a competitor, or on no vendor at all, and did it
even mention you. The results land on the **Pick rate** page and in your AI client.

You work with Octillion from the AI client you already use (Claude, ChatGPT, Claude Code, Cursor and others) over
MCP. This portal is where your team sets up, reads the results and manages budgets.

## Getting started

Open **Setup & training** (the first page in the sidebar). The **Connect your AI client** panel walks you through it:

1. **Pick your client.** Chat apps, coding agents and editors are listed separately.
2. **Add Octillion to it.** Copy your connection URL, then follow the steps shown for your client: a one-click
   install, a command, a config snippet (and the file it goes in), or where to paste it in the client's settings.
   If your URL contains your key, keep it private: anyone with it can use your account.
3. **Check it works.** Press **Test my connection**, open a new chat and type *"Get me started with Octillion."*
   The page waits up to three minutes for your client to reach Octillion and confirms which client connected.

If nothing arrives, check the URL, that you signed in when your client asked, and that the Octillion tools are
switched on in the client; then test again. Recent problems show on the same page.

The **Journeys** panel beside it lists real use cases as step-by-step pipelines, each with the prompt to type for
every stage. Stages are marked done from your real tool calls.

## Your first report in three prompts

1. *"Onboard my product: name, website, docs link."* Octillion researches the product and builds its profile
   (package names, domains, competitors), target developer personas and realistic programming tasks. Research only;
   no coding agents run yet. **Check the competitor list:** a competitor that is missing can't be credited when an
   agent picks it.
2. *"Run a simulation."* Coding agents work each task in their own sandbox. Ask *"How is my simulation doing?"* any time.
3. *"Show my visibility report."* Then ask why agents picked a competitor on a task, or search the transcripts.

## MCP tools

Your AI client calls these for you; you rarely name them. They are listed in the order your client shows them.

### Start and onboard

| Tool | What it does |
|---|---|
| \`get_started\` | What Octillion does and your account's next step. Called first in a new conversation. |
| \`onboard_product\` | Research a product from a short description, its website and docs: profile, competitors, personas and tasks. |
| \`get_onboarding\` | Progress and output of an onboarding: research stage, profile, personas, tasks and the run it launched. |
| \`review_draft_tasks\` | Approve or reject draft tasks research proposed where the task library had nothing fitting. Only approved drafts run. |

### Products and scenarios

| Tool | What it does |
|---|---|
| \`list_products\` | Your products with scenario counts and their 30-day hit rate. |
| \`get_product\` | A product's context (aliases, packages, domains, competitors), its scenarios with hit rate, and recent runs. |
| \`save_product\` | Create or update a product: the names, packages and domains used to detect it (and its competitors) in transcripts. |
| \`save_scenarios\` | Add or edit scenarios: realistic coding tasks phrased the way a developer would, never naming the product. |
| \`browse_task_library\` | Browse Octillion's curated library of real-world developer tasks and turn one into a scenario. |

### Simulations

| Tool | What it does |
|---|---|
| \`run_simulation\` | Launch sandboxed coding agents on the product's scenarios. Runs in the background. |
| \`list_simulations\` | Recent simulations with progress and hit rate. |
| \`get_simulation\` | One simulation: progress, verdict counts, hit rate by model, a scenario × model matrix and every session. |
| \`cancel_simulation\` | Stop a simulation: queued sessions never start, running ones are stopped and their sandboxes shut down. |

### Results and evidence

| Tool | What it does |
|---|---|
| \`get_visibility_report\` | A sectioned report on whether agents pick the product: by platform, task, agent and persona, share of voice, quotes. |
| \`export_visibility_report\` | Export the Pick rate report as tables. |
| \`get_agent_session\` | One agent session: scenario, model, verdict, the tool it went with and the evidence for every product it mentioned. |
| \`get_session_transcript\` | Read a session's raw transcript (messages, tool calls, commands, results), a page at a time. |
| \`search_transcripts\` | Full-text search across your organization's agent transcripts. |

### Personas, tasks and agents

| Tool | What it does |
|---|---|
| \`list_developer_profiles\` | Developer personas you can run with: Octillion's curated ones plus your own. |
| \`save_personas\` | Add or update your own developer personas. Private to your organization. |
| \`list_personas\` | Your organization's own personas, and the ones research picked for your products. |
| \`import_tasks\` | Bring your own tasks as a named task set for a product. Private to your organization. |
| \`list_task_sets\` | Your private task sets and their tasks. |
| \`publish_to_library\` | Offer one of your personas or tasks to Octillion's shared library (see below). |
| \`list_agents\` | The coding-agent mix Octillion simulates for a developer population, with each agent's share and sources. |
| \`save_harness_mix\` | Define your own mix of coding agents, for example only the ones your users run. |
| \`list_harness_mixes\` | Your organization's own harness mixes. |
| \`register_harness\` | Submit your own coding agent as a declarative spec. Built and scanned in isolation; runs only once approved. |
| \`list_harnesses\` | Your private harnesses and their review status. |

### Memory

| Tool | What it does |
|---|---|
| \`save_to_memory\` | Save a lasting fact, decision, preference or note about the company, yourself or a product. |
| \`search_memory\` | Search the account's memory before answering questions about past decisions. |

### Slash commands

Clients that support MCP prompts also offer ready-made playbooks that chain the tools above:
\`onboard_product\`, \`visibility_report\` (a full written report, sectioned like a case study), \`explain_loss\` (why
an agent chose a competitor in one session), \`compare_models\` and \`weekly_digest\`.

## Running a simulation

Ask your client to run a simulation (or call \`run_simulation\`). By default a run is **representative and adaptive**:

- Coding agents are mixed in proportion to real-world developer adoption for a developer population (ask
  *"list agents"* for the current mix and its sources).
- Each scenario starts with a few sessions per developer persona and keeps sampling until its result is stable (a
  narrow 95% interval) or it reaches the per-scenario cap. Tasks where agents agree stop early; contested ones get more.
- Every session runs in its own fresh sandbox.

You can narrow a run to some scenarios, one platform (web, mobile, backend, ...), one of your task sets, chosen
personas, or your own harness mix. To test specific agents or models, name them instead: each runs a fixed number of
times per scenario. Runs on your own harness mix are labelled and never blended into the market-weighted headline.

A run can be cancelled at any time. Your account's budget rules (see Billing) decide who can launch, how many runs one
person can have at once, and how large or expensive a single run may get.

## Reading the Pick rate page

**Pick rate** answers one question: did the coding agents in your simulations pick your product, and what did they
pick instead. The header holds every control: the product, **Competitors**, **Developer personas**, **Tasks** and the
period. Filters live in the page address, so a filtered view can be shared.

### Recommend and avoid tasks

Each task has an expectation. **Recommend** tasks are ones your product should win. **Avoid** tasks are controls where
the right call is not to pick it. Pick rate is measured on recommend tasks only; avoid tasks are scored separately.

### The headline numbers

- **Pick rate**: the share of scored sessions on tasks you should win where the agent picked you, with a trend line.
- **Correctly avoided**: on avoid tasks, the share of sessions where the agent rightly didn't pick you.
- **Top competitor**: the tool most often picked instead of you.
- **Sessions scored**: how many sessions the figures rest on.

A session counts as a pick when the agent built on your product, not when it merely named it. Sample sizes are
small: rates come with a 95% interval, so treat one run as a signal.

### The sections

- **Pick rate over time**: weekly, with the 95% interval as a band.
- **Pick rate by agent, harness, model, developer persona and platform.**
- **Pick rate by task**: hits of scored sessions on each of your tasks, best first.
- **Competitor share**: when an agent didn't pick you, which tool it picked instead.
- **Competitor word cloud**: every tool agents chose or named, sized by how often, marked as picked over you, named
  only, or installed but not tracked. An installed tool that isn't tracked may be a competitor to add to the product.
- **Head-to-head**: on tasks you should win where a competitor came up, how often you won versus it.
- **Why agents chose others**: the main reason in the agent's own words, grouped, for sessions that didn't pick you.
- **How the win showed up**: in sessions lost to a competitor, what the agent did with the other tool: installed its
  package, imported it in code, called its API directly, or recommended it in prose.
- **Expectation check**: recommend vs avoid tasks, with the sessions that made the right and the wrong call.

### Reports

Under **Reports**, pick the filters, dates and sections, then export now or save the report to run again later. Saved
reports are shared with everyone in the account. A print view saves a report as PDF.

## Personas and tasks

Simulations combine **developer personas** with **programming tasks**:

- A **developer persona** describes who is asking: role, experience, company size, stack and constraints. While an
  agent works, Octillion role-plays the persona whenever the agent asks a question.
- A **programming task** (a scenario) is a realistic coding job handed verbatim to the agent, phrased the way a
  developer would and never naming your product.

Octillion keeps a curated library of both; onboarding picks from it for your product, and those show in the portal by
name only. You can bring your own under **Private data**: **Developer personas** and **Programming tasks** (task
sets per product), created here, imported, or saved from your AI client. Your own personas and tasks are private to
your organization.

You can offer one of your own personas or tasks to Octillion's shared library (the **Published** column). Only its
content is shared, never your organization's name. If Octillion accepts it, your organization earns a credit on its
next invoice, shown under **Credits from contributions** on Billing.

## Context

Under **Context**, **Company**, **Users** and **Products** hold what Octillion knows about your company, your people
and your products, including the account's memory (what \`save_to_memory\` saved); **Journeys** shows, person by person,
how far each use case got and where people are stuck. **Usage** shows your team's activity across every AI client,
its simulations and model spend.

## Billing

**Billing** shows this month at the top: model spend against the account's prepaid allowance, a projection to month
end, sessions finished and anything still running. Admins see a banner from 80% of the allowance; members see their own
budget and the rules that apply to them.

### Plans

Running simulations and onboarding needs a prepaid plan. Plans are invite-only for now: ask your Octillion contact to
set one up for your team. Each plan shows its monthly fee, how much model spend it covers a month, any free trial and
any usage pricing. Admins choose a plan and manage the card and invoices through **Manage billing** (Stripe).

### Usage pricing

A plan can add usage-based charges on top of its fee, each with an included amount: **model spend** (priced as a
markup on model cost), **agent sessions** (per completed session), **simulations** (per completed run) and **sandbox
hours**. The plan list shows exactly which apply to yours.

### Budget rules

Admins set how the allowance is spent on the **Budget rules** tab; each rule shows who set it and when:

- **Monthly allowance**: the account's cap on model spend, set by Octillion from your plan.
- **How people share it**: a shared pool, split evenly between the people who can launch, or custom caps per person.
- **Held back (buffer)**: an amount nobody can launch into, which absorbs runs that finish past a limit.
- **New members can launch**: whether everyone can start runs, or only people allowed individually.
- **Runs at once**, **sessions per run** and a **spend cap per run**.
- **Team budgets** and **people's own settings**: set aside a budget for a team, or give a person their own limit.

The **People** tab lists everyone in the account with their role, team, limit and what is left; the **Teams** tab
lists team budgets.
`;

const SECTIONS = Array.from(GUIDE.matchAll(/^## (.+)$/gm), (m) => m[1]);

export function CustomerDocs() {
  return (
    <PageContainer pageTitle='Docs' pageDescription='How Octillion works and how to use it, from connecting your AI client to reading the results.'>
      <div className='grid w-full gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_14rem] lg:items-start'>
        <Markdown className='order-2 lg:order-1'>{GUIDE}</Markdown>
        <nav aria-label='On this page' className='order-1 lg:sticky lg:top-[4.5rem] lg:order-2'>
          <div className='text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase'>On this page</div>
          <ul className='flex flex-wrap gap-x-4 gap-y-1.5 text-sm lg:flex-col'>
            {SECTIONS.map((s) => (
              <li key={s}><Link href={`#${anchorId(s)}`} className='text-muted-foreground hover:text-foreground'>{s}</Link></li>
            ))}
          </ul>
        </nav>
      </div>
    </PageContainer>
  );
}
