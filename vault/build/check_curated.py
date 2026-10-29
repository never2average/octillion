"""Validate a subagent's curated output (accepted tasks only) against its candidate chunk.
  python3 check_curated.py CHUNK.jsonl OUTPUT.json
Validate a vault's developer profiles (a directory holding profiles.json, or the file itself):
  python3 check_curated.py vault/curated
  python3 check_curated.py --selftest       # each profile rule fails on a fixture that breaks it
Exit 0 only when every task (or profile) passes.
"""
import json, os, re, sys, collections
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def profile_problems(profiles):
    """Every shared profile needs survey facets (research filters on them and the server checks persona picks against
    them), a unique display name, an industry from the survey's options, and prose that agrees with its country."""
    from geo import ISO2_REGION, REGIONS, mentioned_countries
    INDUSTRIES = ["Software Development", "Internet, Telecomm or Information Services", "Fintech", "Banking/Financial Services",
                  "Healthcare", "Manufacturing", "Government", "Higher Education", "Retail and Consumer Services",
                  "Transportation, or Supply Chain", "Computer Systems Design and Services", "Media & Advertising Services",
                  "Energy", "Insurance", "Other"]  # so_common.INDUSTRIES (imported there with pyarrow, so repeated here)
    SECTORS = {"academia", "government", "finance", "healthcare", "industry"}
    out = []
    for name, n in collections.Counter(p.get("name") for p in profiles).items():
        if n > 1: out.append(f"name {name!r} is used by {n} profiles")
    for p in profiles:
        pid, a = p.get("id") or p.get("slug") or p.get("name"), p.get("attributes") or {}
        f = a.get("facets") or {}
        if not re.fullmatch(r"[A-Z]{2}", str(f.get("country") or "")) or f.get("country") not in ISO2_REGION:
            out.append(f"{pid}: facets.country must be an ISO2 code (got {f.get('country')!r})")
        elif f.get("region") != ISO2_REGION[f["country"]]:
            out.append(f"{pid}: facets.region must be {ISO2_REGION[f['country']]} for {f['country']} (got {f.get('region')!r})")
        if f.get("region") not in REGIONS: out.append(f"{pid}: facets.region must be one of {REGIONS}")
        if f.get("sector") not in SECTORS: out.append(f"{pid}: facets.sector must be one of {sorted(SECTORS)}")
        if not isinstance(f.get("sector_basis"), list) or not f.get("sector_basis"): out.append(f"{pid}: facets.sector_basis is required")
        if not isinstance(f.get("research_role"), bool): out.append(f"{pid}: facets.research_role must be true or false")
        if a.get("industry") not in INDUSTRIES: out.append(f"{pid}: industry {a.get('industry')!r} is not one of the survey's options")
        named = mentioned_countries(p.get("summary"), skip={str(p.get("name") or "").split(" ")[0]})
        if f.get("country") and named - {f["country"]}:
            out.append(f"{pid}: summary names {sorted(named)} but facets.country is {f['country']}")
    return out


def selftest():
    good = {"id": "t-1", "name": "Ada L.", "summary": "A Canadian academic researcher.", "attributes": {"industry": "Higher Education",
            "facets": {"country": "CA", "region": "north_america", "sector": "academia", "sector_basis": ["DevType: Academic researcher"], "research_role": True}}}
    assert not profile_problems([good]), profile_problems([good])
    def broken(fn):
        p = json.loads(json.dumps(good)); fn(p); return p
    cases = {
        "missing country": broken(lambda p: p["attributes"]["facets"].pop("country")),
        "country not ISO2": broken(lambda p: p["attributes"]["facets"].update(country="Canada")),
        "missing region": broken(lambda p: p["attributes"]["facets"].pop("region")),
        "missing sector": broken(lambda p: p["attributes"]["facets"].pop("sector")),
        "industry not in the enum": broken(lambda p: p["attributes"].update(industry="Higher education")),
        "summary names another country": broken(lambda p: p.update(summary="A Swedish academic researcher.")),
    }
    for what, p in cases.items():
        assert profile_problems([p]), f"{what} was not caught"
    twin = broken(lambda p: p.update(id="t-2"))
    assert any("used by 2" in x for x in profile_problems([good, twin])), "duplicate name was not caught"
    jordan = broken(lambda p: p.update(name="Jordan K.", summary="Jordan is a Canadian student."))
    assert not profile_problems([jordan]), "a first name that is also a country is not a place"
    print(f"selftest ok ({len(cases) + 2} cases)")


if len(sys.argv) == 2:
    if sys.argv[1] == "--selftest":
        selftest(); sys.exit(0)
    path = os.path.join(sys.argv[1], "profiles.json") if os.path.isdir(sys.argv[1]) else sys.argv[1]
    profiles = json.load(open(path))
    problems = profile_problems(profiles)
    print(f"{len(profiles)} profiles in {path}")
    print("\n".join(problems[:60]) if problems else "OK")
    sys.exit(1 if problems else 0)

REPOS = os.environ.get("REPOS_JSON", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "curated", "repos.json"))
cands = {json.loads(l)["source_id"]: json.loads(l) for l in open(sys.argv[1])}
outp = json.load(open(sys.argv[2]))
repos = {r["id"]: r for r in json.load(open(REPOS))}
CATS = {"auth", "database", "background-jobs", "caching", "deployment", "observability", "payments", "email", "messaging",
        "search", "ai", "agents", "storage", "feature-flags", "analytics"}
TEMPLATES = {"express-ts", "nextjs-ts", "node-ts", "fastapi", "django", "go-http", "react-native", "flutter",
             "java-spring", "rust-axum", "cpp-cmake"}
LANG = {"express-ts": "TypeScript", "nextjs-ts": "TypeScript", "node-ts": "TypeScript", "fastapi": "Python", "django": "Python",
        "go-http": "Go", "react-native": "TypeScript", "flutter": "Dart", "java-spring": "Java", "rust-axum": "Rust",
        "cpp-cmake": "C++"}
terms = set(json.load(open(os.path.join(HERE, "vendors.json")))) - {"Ninja", "all models"}
WORDS = {"Make", "Render", "Segment", "Temporal", "Resend", "Neon", "Chroma", "Railway", "Composer", "Cargo", "Passport",
         "Oracle", "Snowflake", "Unleash", "Poetry", "Paddle", "Clerk", "Pip", "Bun", "Pacman", "Lucia", "SES", "Docker"}
alt = lambda ts: "|".join(sorted((re.escape(t) for t in ts), key=len, reverse=True))
_ci = re.compile(r"(?<![\w.])(" + alt(terms - WORDS) + r")(?![\w])", re.I)
_cs = re.compile(r"(?<![\w.])(" + alt(terms & WORDS) + r")(?![\w])")
vendor = lambda s: _ci.search(s) or _cs.search(s)
bad_text = re.compile(r"https?://|[\w.+-]+@[\w-]+\.\w+|stack ?overflow", re.I)

problems = []
ids = [t.get("id") for t in outp]
for i, n in collections.Counter(ids).items():
    if n > 1:
        problems.append(f"duplicate id {i}")
for t in outp:
    tid = t.get("id", "?")
    src = (t.get("source") or {}).get("source_id")
    c = cands.get(src)
    if not c:
        problems.append(f"{tid}: source.source_id must be one of the chunk's candidate source_ids"); continue
    if src.startswith("stackoverflow.com/"):
        want_id = "so-" + src.rsplit("/", 1)[-1]
    elif src.startswith("github.com/"):
        want_id = "mswe-" + re.sub(r"[^a-z0-9]+", "-", src[len("github.com/"):].lower()).strip("-")[:70]
    else:
        want_id = "wc-" + src[:12]
    if tid != want_id:
        problems.append(f"{tid}: id must be {want_id}")
    if t.get("category") not in CATS:
        problems.append(f"{tid}: category must be one of {sorted(CATS)}")
    if t.get("template") not in TEMPLATES:
        problems.append(f"{tid}: template must be one of {sorted(TEMPLATES)}")
    elif t.get("language") != LANG[t["template"]]:
        problems.append(f"{tid}: language must be {LANG[t['template']]} for {t['template']}")
    tags = t.get("tags") or []
    if not (2 <= len(tags) <= 5) or any(vendor(x) for x in tags):
        problems.append(f"{tid}: tags must be 2-5 generic tags without vendor names")
    s = t.get("source") or {}
    for k in ("dataset", "license"):
        if s.get(k) != c.get({"dataset": "source"}.get(k, k)):
            problems.append(f"{tid}: source.{k} must be copied from the candidate ({c.get({'dataset': 'source'}.get(k, k))})")
    for field, lo, hi in (("generic_prompt", 60, 1200), ("prompt", 80, 1200)):
        v = t.get(field) or ""
        if not lo <= len(v) <= hi:
            problems.append(f"{tid}: {field} length {len(v)} outside {lo}-{hi}")
        m = vendor(v + " " + (t.get(field.replace("prompt", "title")) or ""))
        if m:
            problems.append(f"{tid}: {field}/title names vendor/package '{m.group(0)}'")
        if bad_text.search(v):
            problems.append(f"{tid}: {field} contains a URL, email address or mentions the source site")
    if t.get("repo_url"):
        r = repos.get((t.get("repo") or {}).get("id"))
        if not r:
            problems.append(f"{tid}: repo.id must be a repos.json id"); continue
        if r["template"] != t.get("template"):
            problems.append(f"{tid}: repo {r['id']} is {r['template']}, task template is {t.get('template')}")
        if t.get("category") in r["capabilities_present"]:
            problems.append(f"{tid}: repo {r['id']} already has {t['category']}")
        if t["repo_url"] != f"{r['url']}#{r['commit']}":
            problems.append(f"{tid}: repo_url must be exactly {r['url']}#{r['commit']}")
    elif t.get("prompt") != t.get("generic_prompt") or t.get("title") != t.get("generic_title"):
        problems.append(f"{tid}: without repo_url, title/prompt must equal generic_title/generic_prompt")
placed = sum(1 for t in outp if t.get("repo_url"))
print(f"{len(cands)} candidates -> {len(outp)} accepted ({placed} placed in repos)")
print("\n".join(problems[:60]) if problems else "OK")
sys.exit(1 if problems else 0)
