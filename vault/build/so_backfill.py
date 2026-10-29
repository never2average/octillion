"""Deterministic facets for the survey personas: each profile's respondent is looked up again in the Stack Overflow
Developer Survey 2025 and their own answers (country, industry, dev type, employment, org size, AI-agent use) become
attributes.facets. No model writes these: research filters on them and the server checks every persona pick against
them (src/research.ts audienceIssues), so they must be the survey's answers, not prose.

  python -I so_backfill.py download              # the pinned parquet into $VAULT_BUILD_WORK/so (sha256-checked)
  python -I so_backfill.py apply [PROFILES.json] # add facets, normalise industry, dedupe names; fails on any unmatched id
  python -I so_backfill.py apply --check [PROFILES.json]   # exit 1 if apply would change the file
  python -I so_backfill.py selftest              # research_role / academic_staff on the reviewers' cases (no parquet)

SO_SURVEY_PARQUET points at the parquet (default: where `download` puts it). The parquet is never committed.

apply also:
- normalises attributes.industry to the survey's 15 answer options (INDUSTRIES), keeping the old prose as industry_label;
- gives every repeated display name after the first a new last initial (picked by a hash of the response id among the
  letters not yet taken for that first name), rewriting the name in the summary and instructions; product_personas
  links by profile id and stored variants are keyed by slug, so a rename breaks nothing;
- fails when a summary names a country (or demonym) other than the respondent's own.
Two runs give byte-identical output.
"""
import glob, hashlib, json, os, re, string, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from geo import mentioned_countries  # noqa: E402

REPO = "yeper/stack-overflow-developer-survey"
REVISION = "4e41329a5218a6fa905baf461339d451f2db5a37"
FILE = "survey_2025.parquet"
SHA256 = "400b8c9d3cdcebf8b39ae6bfe293a371856b64c20b48ec046c21ca252e50d50e"
PROFILES = os.path.join(HERE, "..", "curated", "profiles.json")
NAME = re.compile(r"^(\S+) ([A-Z])\.$")


def work_dir():
    return os.path.join(os.environ.get("VAULT_BUILD_WORK", "/tmp/vault-work"), "so")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""): h.update(chunk)
    return h.hexdigest()


def parquet_path():
    if os.environ.get("SO_SURVEY_PARQUET"): return os.environ["SO_SURVEY_PARQUET"]
    hits = glob.glob(os.path.join(work_dir(), "hf", "**", REVISION, FILE), recursive=True)
    if not hits: sys.exit(f"no survey parquet: run `so_backfill.py download` or set SO_SURVEY_PARQUET")
    return hits[0]


def download():
    from huggingface_hub import hf_hub_download
    path = hf_hub_download(REPO, FILE, repo_type="dataset", revision=REVISION, cache_dir=os.path.join(work_dir(), "hf"))
    got = sha256(path)
    if got != SHA256: sys.exit(f"{path}: sha256 {got} is not the pinned {SHA256}")
    print(f"{path}\nsha256 ok; export SO_SURVEY_PARQUET={path}")


def survey():
    path = parquet_path()
    got = sha256(path)
    if got != SHA256: sys.exit(f"{path}: sha256 {got} is not the pinned {SHA256} (revision {REVISION})")
    os.environ["SO_SURVEY_PARQUET"] = path
    from so_common import load_survey
    return load_survey().set_index("ResponseId", drop=False)


def dedupe_names(profiles):
    """Every repeat of a display name after the first gets a new last initial; returns {old slug: (old, new)}."""
    taken = {}
    for p in profiles:
        m = NAME.match(p.get("name", ""))
        if not m: sys.exit(f"{p.get('id')}: name {p.get('name')!r} is not 'First L.'")
        taken.setdefault(m.group(1), set()).add(m.group(2))
    seen, renamed = set(), {}
    for p in profiles:
        old = p["name"]
        if old not in seen:
            seen.add(old); continue
        first = NAME.match(old).group(1)
        free = [c for c in string.ascii_uppercase if c not in taken[first]]
        if not free: sys.exit(f"no last initial left for {first}")
        rid = str(p["attributes"]["survey"]["response_id"])
        letter = free[int(hashlib.sha256(rid.encode()).hexdigest(), 16) % len(free)]
        taken[first].add(letter)
        new = f"{first} {letter}."
        for k in ("summary", "instructions"):
            p[k] = re.sub(rf"(?<!\w){re.escape(old)}", new, p.get(k) or "")
        p["name"] = new
        seen.add(new)
        renamed[p["id"]] = (old, new)
    return renamed


def apply(path, check=False):
    from so_common import facets_of, industry_of
    before = open(path, encoding="utf-8").read()
    profiles = json.loads(before)
    df = survey()
    missing, problems = [], []
    for p in profiles:
        a = p.setdefault("attributes", {})
        rid = (a.get("survey") or {}).get("response_id")
        if rid is None or rid not in df.index:
            missing.append(p.get("id")); continue
        row = df.loc[rid]
        f = facets_of(row)
        if not f:
            problems.append(f"{p['id']}: respondent gave no country ({row.Country})"); continue
        a["facets"] = f
        ind = industry_of(row)
        if a.get("industry") != ind:
            if a.get("industry") and "industry_label" not in a: a["industry_label"] = a["industry"]
            a["industry"] = ind
    if missing: sys.exit(f"{len(missing)} of {len(profiles)} profiles have no survey respondent: {missing[:20]}; nothing written")
    renamed = dedupe_names(profiles)
    for p in profiles:
        first = p["name"].split()[0]
        named = mentioned_countries(p.get("summary"), skip={first})
        if named - {p["attributes"]["facets"]["country"]}:
            problems.append(f"{p['id']}: summary names {sorted(named)} but the respondent is in {p['attributes']['facets']['country']}")
    if problems: sys.exit("\n".join(problems) + "\nnothing written")
    after = json.dumps(profiles, indent=2, ensure_ascii=False) + "\n"
    if check:
        if after != before: sys.exit(f"{path} is not up to date: run so_backfill.py apply")
        print(f"{path}: {len(profiles)}/{len(profiles)} profiles have facets; up to date"); return
    with open(path, "w", encoding="utf-8") as f: f.write(after)
    print(f"{len(profiles)}/{len(profiles)} profiles matched and faceted; {len(renamed)} renamed: " +
          ", ".join(f"{k} {o}->{n}" for k, (o, n) in list(renamed.items())[:8]) + (" ..." if len(renamed) > 8 else ""))


def selftest():
    """research_role means research-affiliated, academic_staff a university's technical staff: the cases that went wrong
    (students whose job is at a software company counted as researchers) and the ones that must stay right."""
    from types import SimpleNamespace
    from so_common import academic_staff, research_role
    MA, BA = "Master’s degree (M.A., M.S., M.Eng., MBA, etc.)", "Bachelor’s degree (B.A., B.S., B.Eng., etc.)"
    PHD, SEC = "Professional degree (JD, MD, Ph.D, Ed.D, etc.)", "Secondary school (e.g. American high school, German Realschule or Gymnasium, etc.)"
    row = lambda dev, ind, emp, ed=MA: SimpleNamespace(DevType=dev, Industry=ind if ind else float("nan"), Employment=emp, EdLevel=ed)
    cases = [  # (dev type, industry, employment[, highest degree]) -> (research_role, academic_staff)
        (("Academic researcher", "Higher Education", "Employed", PHD), (True, False)),
        (("Academic researcher", None, "Student"), (True, False)),
        (("Academic researcher", "Other:", "Employed", PHD), (True, False)),         # a research institute
        (("Academic researcher", None, "Not employed"), (False, False)),            # so25-17155: no institution now
        (("Academic researcher", "Software Development", "Employed", BA), (False, False)),  # so25-39139: a company's researcher
        (("Student", None, "Student"), (True, False)),                              # a graduate student
        (("Student", "Higher Education", "Student", PHD), (True, False)),
        (("Student", None, "Student", BA), (False, False)),                         # so25-32122: coursework only
        (("Developer, full-stack", None, "Student", SEC), (False, False)),          # so25-29213
        (("Developer, back-end", "Software Development", "Student"), (False, False)),  # so25-14188: works at a software company
        (("Student", "Software Development", "Student"), (False, False)),           # so25-24672
        (("Student", "Internet, Telecomm or Information Services", "Student"), (False, False)),  # so25-13334
        (("Data scientist", None, "Student", BA), (True, False)),                   # a research dev type while studying
        (("Data scientist", "Insurance", "Employed"), (False, False)),
        (("Data scientist", "Government", "Employed"), (False, False)),
        (("Data scientist", "Higher Education", "Employed"), (True, False)),
        (("Applied scientist", "Higher Education", "Employed"), (True, False)),
        (("Developer, back-end", "Higher Education", "Employed"), (False, True)),   # a research software engineer
        (("System administrator", "Higher Education", "Employed"), (False, True)),  # research-computing staff
        (("Developer, back-end", "Higher Education", "Independent contractor, freelancer, or self-employed"), (False, False)),  # a contractor
        (("Project manager", "Higher Education", "Employed"), (False, False)),
        (("Developer, full-stack", "Software Development", "Employed"), (False, False)),
    ]
    for args, want in cases:
        got = (research_role(row(*args)), academic_staff(row(*args)))
        assert got == want, f"{args}: research_role, academic_staff = {got}, want {want}"
    print(f"selftest ok ({len(cases)} cases)")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["download"]: download()
    elif args[:1] == ["selftest"]: selftest()
    elif args[:1] in (["apply"], ["--check"]):
        rest = [a for a in args[1:] if a != "--check"]
        apply(rest[0] if rest else PROFILES, check="--check" in args)
    else: sys.exit(__doc__)
