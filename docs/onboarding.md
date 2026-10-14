# Product onboarding: prompt + link + docs → profile, personas, problems → runs

A dev-tool company describes its product in three things: a **prompt** (what it is and for whom), a **link**
(website) and **documentation** (docs URL). The rest is automatic:

1. **Research.** The orchestrator (Pi, the same brain that plays the developer) reads the website and docs and builds
   a **detailed product profile**: name, category, description, key features, aliases, package names (npm, PyPI,
   etc.), domains, and **competitors** (with their packages and domains).
2. **Personas.** It derives the **target developer personas** who would plausibly need the product: role,
   experience, company size, stack, constraints and tone, plus instructions for how each answers a coding agent's
   questions.
3. **Problems.** It **searches** the curated task library for fitting tasks and **creates** new realistic
   programming problems where the product could be a recommended solution. Each problem is phrased the way a
   developer would ask a coding agent, never naming the product, its packages or its domains. It may add a few
   `avoid` problems where the product should not be the answer.
4. **Runs.** The server saves everything (product context, product-scoped personas, scenarios) and, unless turned
   off, launches a representative simulation across the coding-agent mix with those personas.

```
customer (Claude/ChatGPT) ── onboard_product{prompt, website_url, docs_url} ──▶ server: product + research job
orchestrator ── claim research ─▶ Pi research session ─ fetch_url / search_library / validate ─▶ submit
server ── apply: product profile, personas, scenarios ──▶ run_simulation (coding agents × personas × samples)
customer ── get_onboarding / get_visibility_report ──▶ results
```

## MCP tools (customer)

`onboard_product` `{prompt, website_url?, docs_url?, name?, run?: true, samples?}` → research id, status.
`get_onboarding` `{research_id? | product?}` → stage, generated profile, personas, scenarios and the simulation.

## Worker API (orchestrator; Bearer `OCTILLION_WORKER_TOKEN`)

- **`POST /api/worker/research/claim`** `{worker_id, limit?}` →
  `{jobs: [{research_id, input: {name?, prompt, website_url?, docs_url?}, limits}]}`.
  `limits` holds `{max_personas, max_scenarios, min_scenarios, max_competitors}`.
- **`POST /api/worker/research/:id/progress`** `{stage, note?}` is the heartbeat. Stages: `reading`, `profiling`,
  `personas`, `problems`, `validating`.
- **`GET /api/worker/library/tasks?query=&category=&language=&limit=`** searches the curated task library.
- **`POST /api/worker/research/:id/validate`** `{result}` → `{ok, issues: [...]}`. Dry run; nothing is saved.
- **`POST /api/worker/research/:id/complete`** `{status: "completed" | "failed", error?, result?}` →
  `{product, personas, scenarios, simulation_id?}`, or 422 `{issues}` when the result is invalid. Revise and resubmit.

`result`:
```json
{ "product": { "name": "…", "description": "…", "category": "…", "website_url": "…", "docs_url": "…",
               "features": ["…"], "aliases": ["…"], "packages": ["…"], "domains": ["…"],
               "competitors": [{"name": "…", "aliases": [], "packages": [], "domains": []}] },
  "personas": [{ "name": "…", "summary": "…", "attributes": {"role": "…", "experience_years": 5, "company_size": "…",
                 "stack": ["…"], "constraints": ["…"], "tone": "…"}, "instructions": "…" }],
  "scenarios": [{ "title": "…", "prompt": "…", "language": "…", "tags": ["…"], "expectation": "recommend" | "avoid",
                  "rationale": "why the product fits (or not)", "library_task_id": 12, "repo_url": null }],
  "sources": [{"url": "…", "title": "…"}] }
```

**Validation** (the same rules apply on `validate` and `complete`):
- **Scenario prompts must not name the product.** No name, alias, package or domain (a whole-word,
  case-insensitive match), and no competitor names either, so as not to lead the agent.
- **Counts:** `min_scenarios` ≤ scenarios ≤ `max_scenarios`, 1 ≤ personas ≤ `max_personas`, at least one `recommend`
  scenario, and prompts of 40–2000 characters.
- **Product fields:** at least one alias, package or domain beyond the name, so detection has something to match;
  competitor names must be distinct from the product.
- **Personas** must not mention the product or its competitors (they answer the agent blind).
