# Curated vault build

Builds `vault/curated/profiles.json` and `vault/curated/tasks.json` from public data. Every model call uses
`gpt-6.1-sol`, with a disk cache (re-runs only pay for new inputs) and a hard spend cap (`VAULT_BUILD_BUDGET`, default $15).

```bash
python -m venv .venv && .venv/bin/pip install pyarrow pandas huggingface_hub
export OPENAI_API_KEY=... VAULT_BUILD_WORK=/tmp/vault-work
export SO_SURVEY_PARQUET=/path/to/survey_2025.parquet   # Stack Overflow Developer Survey 2025, ODbL
# Tasks: WildChat-4.8M shards (one shard on disk at a time), then classify + blind rewrite + vendor check.
.venv/bin/python wildchat_extract.py $VAULT_BUILD_WORK/wc 0 86
.venv/bin/python tasks_build.py $VAULT_BUILD_WORK/wc/candidates.jsonl ../curated/tasks.json 50
# Personas: random respondents (professional developers who use AI agents at work), written blind.
.venv/bin/python so_personas.py ../curated/profiles.json 150
# Researcher personas: academic researchers, data scientists and applied scientists who use AI agents at work (many
# write code for their research rather than as developers). Sampled here; the drafts are written from the brief in
# FACTS.json, then merge checks them against their respondents and adds them to the profiles.
.venv/bin/python so_researchers.py sample 40 $VAULT_BUILD_WORK/researcher-facts.json
.venv/bin/python so_researchers.py merge $VAULT_BUILD_WORK/researcher-facts.json DRAFTS.json ../curated/profiles.json
```

Then load into a local Postgres: `VAULT_DIR=vault/curated npm run vault:sync`. Into a shared or production database,
load the profiles only, with a dry run first (never `vault:sync`: VAULT_URL wins over VAULT_DIR, it retires every task
and profile not in the directory and it runs migrations):
`DATABASE_URL=... npx tsx scripts/sync-profiles.ts vault/curated --dry-run`, then the same without `--dry-run`.

## Survey facets, names and thin segments (no model, no paid API)

Every shared profile carries `attributes.facets`: its respondent's own survey answers (country as ISO2, region, sector,
`sector_basis`, `research_role`, `academic_staff`, dev type, industry, org size, employment, AI-agent use). Research filters on them and
the server checks every persona pick against the product's audience with them (`src/audience.ts`); `npm run vault:sync`
refuses a profile without `facets.country`. Use the venv at `/root/persona-axes-dataset/rl/.venv/bin/python` (pyarrow,
pandas, huggingface_hub) with `-I`.

```bash
# The survey: yeper/stack-overflow-developer-survey at revision 4e41329a5218a6fa905baf461339d451f2db5a37,
# survey_2025.parquet, sha256 400b8c9d3cdcebf8b39ae6bfe293a371856b64c20b48ec046c21ca252e50d50e (checked; never committed).
python -I so_backfill.py download                 # into $VAULT_BUILD_WORK/so; prints the SO_SURVEY_PARQUET to export
python -I so_backfill.py apply                    # facets for every profile (fails unless all response ids match),
                                                  # industry normalised to the survey's 15 options (old prose kept as
                                                  # industry_label), repeated names given a new last initial
python -I so_backfill.py --check                  # exit 1 if apply would change the file (byte-identical re-runs)
python3 -I check_curated.py ../curated            # facets, unique names, industry options, summary country = facets,
                                                  # no provider-shaped wording (a national compute allocation, a
                                                  # consortium), no company size the survey did not give, no
                                                  # graduate/doctoral claim beyond the survey's degree, no industry_label
                                                  # the survey did not give, at most 2 researchers per country with an
                                                  # unmet compute need (constraints read like other countries')
python3 -I check_curated.py --selftest
```

- `so_common.derive_sector` (shared by the backfill and both samplers), first match wins: academia (a student, an
  academic researcher, or Industry = Higher Education), government, finance (banking, fintech, insurance), healthcare,
  else industry. `research_role` is separate and means research-affiliated: an academic researcher, employed or
  studying, whose industry is Higher Education, none or Other (a research institute; not a company's researcher), a data or applied scientist
  whose industry is Higher Education, or a student with no other industry who is a graduate student (a master's or
  professional/doctoral degree already, `ed_level`) or has a research dev type. A student working at a software
  company, or an undergraduate, is academia by sector but no researcher. `academic_staff` is a university's
  technical staff (Industry Higher Education, employed (not a contractor), a developer or infrastructure role: research software engineers,
  research-computing staff), so an audience can admit "researchers or the staff they sponsor" without calling staff
  researchers. `python -I so_backfill.py selftest` checks both on the cases that went wrong.
- `geo.py` maps the survey's country names to ISO2 and regions, and the names and demonyms prose uses; `python geo.py
  --ts > ../../src/geo-data.ts` regenerates the server's copy.

Thin segments (`segments.json`) are topped up from respondents not yet in the data, stratified by dev type and
seniority; a cell with fewer respondents than its minimum is reported "supply-limited" and never padded:

```bash
python -I so_researchers.py sample --segment ca-academia $VAULT_BUILD_WORK/ca-facts.json --relax-ai
python -I so_researchers.py sample --segment in-finance $VAULT_BUILD_WORK/in-facts.json
# Subagents write DRAFTS.json from each FACTS.json brief (country and institution as the facts give them; realistic
# academic constraints such as shared or national compute allocations and in-country data; no vendors), then:
python -I so_researchers.py merge $VAULT_BUILD_WORK/ca-facts.json CA-DRAFTS.json ../curated/profiles.json
python -I so_backfill.py apply && python3 -I check_curated.py ../curated
```

`--relax-ai` makes "uses AI agents at work" a preference rather than a filter (only 12 Canadian academic researchers not
already in the data use agents at work); the answer is kept in `facets.ai_agents`. Loading the result into production
(`scripts/sync-profiles.ts`, above) is an operator step.

Rules the build enforces:
- Tasks and personas never name a vendor, hosted service, database product, cloud or third-party package (regex check
  against the survey's own database/platform/AI answer options plus well-known dev-tool vendors; failures are rewritten
  or dropped). Languages and the starter project's framework are allowed.
- Personal data is dropped at classification and stripped at rewrite.

Next source: [SALT-NLP/SWE-chat](https://huggingface.co/datasets/SALT-NLP/SWE-chat) (real Claude Code / Codex sessions,
ODC-BY, gated: accept its terms on Hugging Face with the account whose token this machine uses).

## More sources and round 2

- `so_extract.py`: Stack Overflow questions (`pacovaldez/stackoverflow-questions`, CC BY-SA 4.0) whose title asks how to
  add a capability (email, payments, feature flags, analytics, jobs, storage, ...). Code blocks and HTML are stripped.
- `round2.py`: unclassified WildChat candidates in thin categories + a quota-weighted Stack Overflow sample.

## Placing tasks in example repositories

`vault/curated/repos.json` lists 44 permissively licensed apps, pinned to commits, with the capabilities each already has.
Placement is done by Claude subagents, not a paid API:

1. `prep_place.py` merges task rounds, writes `vendors.json` and splits tasks into per-stack chunks (`place/*.json`).
2. One subagent per chunk rewrites each task into a fitting repo (same stack, capability not already present, balanced
   across repos), adds `repo_url` = `<url>#<commit>`, keeps the original as `generic_prompt`, and must pass
   `check_placed.py <chunk> <output>` (ids unchanged, exact pinned URL, no vendor names, no URLs/emails, length bounds).
3. `merge_placed.py` re-validates every chunk and writes the final library.

## Curation by subagents (full corpus)

The large corpus (5,500+ tasks) is curated by Claude subagents, not a paid API:

1. `so_full_extract.py` (full Stack Overflow dump, engagement + stack + capability pre-filter; DBMS, mobile and
   agent-building modes) and `wildchat_agents_extract.py` produce candidates for free.
2. `chunk_curate.py <wave>` splits new candidates into 150-item chunks; `make_queue.py` orders pending chunks by value.
3. One subagent per chunk follows `curate/BRIEF.md` (judge, blind rewrite, place into a pinned repo) and must pass
   `check_curated.py <chunk> <output>`.
4. `build_library.py` merges, dedupes, re-validates and caps placements at 25 per repo per category;
   `audit_library.py` checks the whole library before it ships.
