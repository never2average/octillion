"""Researcher and scientist personas grounded in the Stack Overflow Developer Survey 2025 (ODbL), and top-ups of thin
segments (who may use a product: country, sector, research role).

The main persona set (so_personas.py) samples professional developers, so researchers barely appear in it. Scientific
software (simulation packages, ML research code, lab tooling) is used mostly by academic researchers, data scientists and
applied scientists, many of whom are not developers by profession but write code for their work or studies. This samples
those respondents who use AI agents at work, at random, so the set follows the survey's real mix.

  python -I so_researchers.py sample N FACTS.json            # researchers anywhere (the original set)
  python -I so_researchers.py sample N FACTS.json --country CA --sector academia --research-role [--relax-ai]
  python -I so_researchers.py sample --segment ca-academia FACTS.json   # a cell of segments.json, at least its min
  python -I so_researchers.py merge FACTS.json DRAFTS.json PROFILES.json

A cell (--country/--sector/--research-role) is drawn from respondents whose survey facets (so_common.facets_of) match,
excluding those already in vault/curated/profiles.json, stratified by dev type and seniority. --relax-ai makes "uses AI
agents at work" a preference instead of a filter (thin cells have few such respondents); the answer is still recorded in
facets.ai_agents. A cell with fewer respondents than asked is reported "supply-limited" and never padded.

The narrative and answering instructions are written from FACTS.json (one draft per respondent, same keys as a
profile, "id" = the fact's id) by subagents, not a paid API. merge checks each draft against its respondent and the same
blind rules as so_personas.py (no vendor names, no inventing seniority or stack, the country as the survey gives it),
then adds the drafts to PROFILES.json. Run so_backfill.py apply and check_curated.py after merging.
"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from so_common import facts, facets_of, load_survey, vendor_regex  # noqa: E402
from geo import mentioned_countries  # noqa: E402

DEV_TYPES = ["Academic researcher", "Data scientist", "Applied scientist"]
BRANCHES = ["I am a developer by profession", "I am not primarily a developer, but I write code sometimes as part of my work/studies"]
EMPLOYMENT = ["Employed", "Independent contractor, freelancer, or self-employed", "Student"]
PROFILES = os.path.join(HERE, "..", "curated", "profiles.json")
SEGMENTS = os.path.join(HERE, "segments.json")

BRIEF = """Write one researcher persona per respondent for a simulation. A coding agent works on a task for this person;
when the agent asks a question, an orchestrator answers in character using the persona. Ground everything in the survey
attributes; do not invent seniority, institution size or stack beyond them. A respondent whose main_branch says they are
not primarily a developer writes code for their research: they know their science and their scripts, not software
engineering practice, and they say so.
Hard rules:
- Never name any database, cloud/hosting platform, SaaS tool, vendor, AI model or third-party package. Describe them
  generically ("a shared university compute cluster", "a major public cloud", "the lab's existing analysis scripts").
- You MAY name programming languages and web frameworks from the attributes.
- State the country and the kind of institution exactly as the facts give them (facets.country_name, facets.sector,
  industry, employment): "a doctoral student at a Canadian university", "a data scientist at an Indian bank". Never
  another country, and no real institution names.
- For academia, write realistic constraints: shared or national research-computing allocations and batch queues, a
  supervisor's or a grant's budget, research data that must stay in the country when the facts imply it.
- Invent a plausible first name + last initial matching nothing real, distinct from the names already in the data. No
  real people, institutions or papers.
- instructions: 3-6 sentences on how this person answers a coding agent: what they care about (reproducible results,
  correctness of the numbers, running on the hardware they have, a deadline for a paper or thesis, grant budget, the
  group's existing code), what they defer to the agent. They never suggest a specific vendor or package; if the agent
  offers options, they choose by their constraints.
Each draft: {"id", "name", "summary" (1-2 sentences), "attributes": {"role", "experience_years" (int), "company_size",
"industry", "work_mode", "stack" (languages + web frameworks only), "constraints" (3-5 short items), "tone",
"buying_influence", "ai_agent_use"}, "instructions"}"""


def years(v):
    try: return int(float(v))
    except (TypeError, ValueError): return None


def seniority(v):
    y = years(v)
    return "unknown" if y is None else "junior" if y <= 2 else "mid" if y <= 9 else "senior"


def in_pool(path=PROFILES):
    try: return {int(p["attributes"]["survey"]["response_id"]) for p in json.load(open(path)) if (p.get("attributes") or {}).get("survey")}
    except FileNotFoundError: return set()


def stratified(rows, n, seed, prefer_ai):
    """Up to n rows, round-robin over (dev type, seniority) strata so a thin cell is not all one kind of respondent;
    within a stratum, AI-agent users first when they are only preferred."""
    strata = {}
    for _, r in rows.sample(frac=1, random_state=seed).iterrows():
        strata.setdefault((r.DevType, seniority(r.WorkExp)), []).append(r)
    if prefer_ai:
        for k in strata: strata[k].sort(key=lambda r: 0 if str(r.AIAgents).startswith("Yes") else 1)
    out, keys = [], sorted(strata, key=lambda k: (-len(strata[k]), str(k)))
    while len(out) < n and any(strata[k] for k in keys):
        for k in keys:
            if strata[k] and len(out) < n: out.append(strata[k].pop(0))
    return out


def sample(n, out, country=None, sector=None, research_role=None, relax_ai=False, segment=None):
    df = load_survey()
    if not (country or sector or research_role is not None):
        pool = df[df.DevType.isin(DEV_TYPES) & df.MainBranch.isin(BRANCHES) & df.Employment.isin(EMPLOYMENT)
                  & df.AIAgents.fillna("").str.startswith("Yes") & df.WorkExp.notna() & df.LanguageHaveWorkedWith.notna()]
        print(f"eligible researcher respondents: {len(pool)} of {len(df)}")
        rows = [r for _, r in pool.sample(n=n, random_state=20261016).iterrows()]
    else:
        taken = in_pool()
        base = df[df.MainBranch.isin(BRANCHES) & df.LanguageHaveWorkedWith.notna() & ~df.ResponseId.isin(taken)]
        if not relax_ai: base = base[base.AIAgents.fillna("").str.startswith("Yes")]
        fs = base.apply(facets_of, axis=1)
        keep = fs.map(lambda f: bool(f) and (not country or f["country"] == country) and (not sector or f["sector"] == sector)
                      and (research_role is None or f["research_role"] == research_role))
        pool = base[keep]
        label = segment or f"{country or '*'}/{sector or '*'}/{'researcher' if research_role else '*'}"
        print(f"{label}: {len(pool)} respondents not yet in the data ({'AI agents preferred' if relax_ai else 'AI-agent users only'})")
        if len(pool) < n: print(f"{label}: supply-limited: {len(pool)} of the {n} wanted; nothing is padded")
        rows = stratified(pool, n, 20261029, relax_ai)
    items = [{"id": f"so25-{int(r.ResponseId)}", "response_id": int(r.ResponseId), "segment": segment, "facets": facets_of(r), "facts": facts(r)} for r in rows]
    json.dump({"brief": BRIEF, "respondents": items}, open(out, "w"), indent=1, ensure_ascii=False, default=str)
    mix = {}
    for it in items: mix[it["facts"]["dev_type"]] = mix.get(it["facts"]["dev_type"], 0) + 1
    print(f"wrote {len(items)} respondents to {out}; mix: {mix}")


def issues(d, r, vendor_re, names):
    f = r["facts"]
    out = []
    for k in ("name", "summary", "instructions"):
        if not str(d.get(k) or "").strip(): out.append(f"{k} is missing")
    a = d.get("attributes") or {}
    for k in ("role", "experience_years", "company_size", "industry", "work_mode", "stack", "constraints", "tone",
              "buying_influence", "ai_agent_use"):
        if k not in a: out.append(f"attributes.{k} is missing")
    text = json.dumps({k: d.get(k) for k in ("name", "summary", "instructions")}) + json.dumps(a.get("constraints"))
    if (hit := vendor_re.search(text)): out.append(f"names a vendor: {hit.group(0)}")
    allowed = {x.lower() for x in f["languages"] + f["web_frameworks"]}
    extra = [x for x in a.get("stack") or [] if str(x).lower() not in allowed]
    if extra: out.append(f"stack adds {extra}, not in the respondent's languages or frameworks")
    if a.get("experience_years") is not None and years(f["years_professional"]) is not None \
            and abs(years(a["experience_years"]) - years(f["years_professional"])) > 1:
        out.append(f"experience_years {a['experience_years']} differs from the survey's {f['years_professional']}")
    role_word = str(f["dev_type"] or "").split()[0].strip(",;").lower()
    if role_word and role_word not in str(a.get("role", "")).lower():
        out.append(f"role does not say {f['dev_type']}")
    fc = r.get("facets") or {}
    if fc.get("country"):
        named = mentioned_countries(d.get("summary"), skip={str(d.get("name") or "").split(" ")[0]})
        if fc["country"] not in named: out.append(f"summary must say where they are ({fc['country_name']})")
        if named - {fc["country"]}: out.append(f"summary names {sorted(named)}; the respondent is in {fc['country']}")
    if d.get("name") in names: out.append(f"name {d.get('name')} is already used; pick another")
    return out


def merge(facts_path, drafts_path, profiles_path):
    resp = {x["id"]: x for x in json.load(open(facts_path))["respondents"]}
    drafts = json.load(open(drafts_path))
    profiles = json.load(open(profiles_path))
    names = {p["name"] for p in profiles if p.get("id") not in resp}
    vendor_re = vendor_regex(load_survey())
    bad, good = {}, []
    for d in drafts:
        r = resp.get(d.get("id"))
        if not r: bad[str(d.get("id"))] = ["id is not a sampled respondent"]; continue
        if (e := issues(d, r, vendor_re, names)): bad[d["id"]] = e; continue
        names.add(d["name"])
        d["attributes"]["survey"] = {"source": "Stack Overflow Developer Survey 2025", "response_id": r["response_id"],
                                     "license": "ODbL-1.0", "segment": r.get("segment") or "researcher"}
        good.append(d)
    if bad:
        print(json.dumps(bad, indent=1)); sys.exit(f"{len(bad)} drafts failed; nothing merged")
    missing = sorted(set(resp) - {d["id"] for d in good})
    if missing: sys.exit(f"no draft for {missing}; nothing merged")
    ids = {d["id"] for d in good}
    profiles = [p for p in profiles if p.get("id") not in ids] + good
    json.dump(profiles, open(profiles_path, "w"), indent=2, ensure_ascii=False)
    print(f"merged {len(good)} personas; {len(profiles)} profiles in {profiles_path}; now run so_backfill.py apply and check_curated.py")


def opt(name, default=None):
    a = sys.argv
    return a[a.index(name) + 1] if name in a else default


if __name__ == "__main__":
    if sys.argv[1:2] == ["sample"]:
        if "--segment" in sys.argv:
            seg = next(s for s in json.load(open(SEGMENTS)) if s["id"] == opt("--segment"))
            rest = [x for x in sys.argv[2:] if x not in ("--segment", seg["id"], "--relax-ai")]
            sample(seg["min"], rest[0], seg.get("country"), seg.get("sector"), seg.get("research_role"), "--relax-ai" in sys.argv, seg["id"])
        else:
            pos = [x for i, x in enumerate(sys.argv[2:], 2) if not x.startswith("--") and not sys.argv[i - 1] in ("--country", "--sector")]
            sample(int(pos[0]), pos[1], opt("--country"), opt("--sector"), True if "--research-role" in sys.argv else None, "--relax-ai" in sys.argv)
    elif sys.argv[1:2] == ["merge"]: merge(*sys.argv[2:5])
    else: sys.exit(__doc__)
