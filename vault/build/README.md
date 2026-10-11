# Curated vault build

Builds `vault/curated/profiles.json` and `vault/curated/tasks.json` from public data. Every model call uses
`gpt-6.1-sol`, with a disk cache (re-runs only pay for new inputs) and a hard spend cap (`VAULT_BUILD_BUDGET`, default $15).

```bash
python -m venv .venv && .venv/bin/pip install pyarrow pandas huggingface_hub
export OPENAI_API_KEY=... VAULT_BUILD_WORK=/tmp/vault-work
export SO_SURVEY_PARQUET=/path/to/survey_2025.parquet   # Stack Overflow Developer Survey 2025, ODbL
# Tasks: WildChat-4.8M shards (one shard on disk at a time), then classify + blind rewrite + vendor check.
.venv/bin/python wildchat_extract.py $VAULT_BUILD_WORK/wc 0 70
.venv/bin/python tasks_build.py $VAULT_BUILD_WORK/wc/candidates.jsonl ../curated/tasks.json 50
# Personas: random respondents (professional developers who use AI agents at work), written blind.
.venv/bin/python so_personas.py ../curated/profiles.json 150
```

Then load into Postgres: `VAULT_DIR=vault/curated npm run vault:sync`.

Rules the build enforces:
- Tasks and personas never name a vendor, hosted service, database product, cloud or third-party package (regex check
  against the survey's own database/platform/AI answer options plus well-known dev-tool vendors; failures are rewritten
  or dropped). Languages and the starter project's framework are allowed.
- Personal data is dropped at classification and stripped at rewrite.
- Shards above 69 are skipped on small machines: loading one needs about 4.5 GB of RAM.

Next source: [SALT-NLP/SWE-chat](https://huggingface.co/datasets/SALT-NLP/SWE-chat) (real Claude Code / Codex sessions,
ODC-BY, gated: accept its terms on Hugging Face with the account whose token this machine uses).
