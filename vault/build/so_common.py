"""Shared pieces of the survey persona builders: the survey table, its list fields and the vendor-name check."""
import os, re
import pyarrow.parquet as pq

split = lambda v: [x.strip() for x in str(v).split(";") if x and str(v) != "nan"]


def load_survey():
    return pq.read_table(os.environ["SO_SURVEY_PARQUET"]).to_pandas()


def vendor_regex(df):
    """Vendor names respondents could pick for databases, platforms and AI models: personas must never name these."""
    vendors = set()
    for col in ["DatabaseHaveWorkedWith", "PlatformHaveWorkedWith", "AIModelsHaveWorkedWith", "OfficeStackAsyncHaveWorkedWith",
                "CommPlatformHaveWorkedWith"]:
        for v in df[col].dropna():
            vendors.update(split(v))
    stop = {"Other", "None", "Bash/Shell (all shells)", "Docker", "npm", "Homebrew", "Make", "Kubernetes"}
    terms = set()
    for v in vendors - stop:
        for part in re.split(r"[()/]", v):
            part = part.strip()
            if len(part) >= 4 and not part.lower() in {"models", "chatbot", "reasoning", "general", "purpose", "flash", "build tool", "image generating models"}:
                terms.add(part)
    return re.compile(r"\b(" + "|".join(sorted((re.escape(t) for t in terms), key=len, reverse=True)) + r")\b", re.I)


def generic_platforms(ps):
    s = set()
    for x in ps:
        xl = x.lower()
        if any(k in xl for k in ("aws", "azure", "google cloud", "oracle cloud", "ibm cloud", "alibaba")): s.add("major public cloud")
        elif any(k in xl for k in ("vercel", "netlify", "heroku", "render", "fly.io", "railway", "cloudflare", "digital ocean", "firebase", "supabase")): s.add("managed PaaS / edge hosting")
        elif any(k in xl for k in ("kubernetes", "docker", "podman")): s.add("containers")
        elif any(k in xl for k in ("terraform", "ansible", "pulumi")): s.add("infrastructure as code")
        elif any(k in xl for k in ("datadog", "new relic", "prometheus", "grafana", "sentry", "splunk")): s.add("observability tooling")
    return sorted(s)


def facts(row):
    f = {
        "dev_type": row.DevType, "main_branch": row.MainBranch, "employment": row.Employment, "years_professional": row.WorkExp,
        "years_coding": row.YearsCode, "org_size": row.OrgSize, "ic_or_manager": row.ICorPM, "industry": row.Industry,
        "remote": row.RemoteWork, "country": row.Country, "purchase_influence": row.PurchaseInfluence, "ai_agents": row.AIAgents,
        "languages": split(row.LanguageHaveWorkedWith), "web_frameworks": split(row.WebframeHaveWorkedWith),
        "database_count": len(split(row.DatabaseHaveWorkedWith)), "platforms_generic": generic_platforms(split(row.PlatformHaveWorkedWith)),
    }
    return {k: (None if str(v) == "nan" else v) for k, v in f.items()}


# ---------- facets: who the respondent is, from their survey answers alone (so_backfill.py and both samplers) ----------

# The survey's Industry answer options, with the free-text "Other:" (and no answer) folded into "Other".
INDUSTRIES = ["Software Development", "Internet, Telecomm or Information Services", "Fintech", "Banking/Financial Services",
              "Healthcare", "Manufacturing", "Government", "Higher Education", "Retail and Consumer Services",
              "Transportation, or Supply Chain", "Computer Systems Design and Services", "Media & Advertising Services",
              "Energy", "Insurance", "Other"]
SECTORS = ["academia", "government", "finance", "healthcare", "industry"]
# Scientists count as researchers only at a university: a data scientist at an insurer analyses claims, not research.
SCIENTIST_DEV_TYPES = {"Applied scientist", "Data scientist"}
# Technical roles that research infrastructure serves when held at a university (research software engineers, HPC and
# research-computing staff). Managers, designers, analysts and sales are not; nor is anyone not employed there.
STAFF_DEV_TYPES = {"Developer, full-stack", "Developer, back-end", "Developer, front-end", "Developer, desktop or enterprise applications",
                   "Developer, mobile", "Developer, embedded applications or devices", "Developer, game or graphics", "Developer, QA or test",
                   "Developer, AI apps or physical AI", "AI/ML engineer", "Data engineer", "DevOps engineer or professional",
                   "Cloud infrastructure engineer", "System administrator", "Database administrator or engineer",
                   "Architect, software or solutions", "Support engineer or analyst"}
WORKING = {"Employed", "Independent contractor, freelancer, or self-employed"}
FINANCE = {"Banking/Financial Services", "Fintech", "Insurance"}


def _clean(v):
    return None if v is None or str(v) == "nan" else str(v)


def industry_of(row):
    v = _clean(row.Industry)
    return v if v in INDUSTRIES else "Other"


def derive_sector(row):
    """(sector, basis): the first rule that matches, with every answer that supports it. Academia is anyone studying or
    researching at, or working for, a university: a student, an academic researcher, or Industry = Higher Education."""
    emp, dev, ind = split(row.Employment), _clean(row.DevType), _clean(row.Industry)
    academia = (["Employment: Student"] if "Student" in emp else []) + \
               (["DevType: Academic researcher"] if dev == "Academic researcher" else []) + \
               (["Industry: Higher Education"] if ind == "Higher Education" else [])
    if academia: return "academia", academia
    if ind == "Government": return "government", ["Industry: Government"]
    if ind in FINANCE: return "finance", [f"Industry: {ind}"]
    if ind == "Healthcare": return "healthcare", ["Industry: Healthcare"]
    return "industry", [f"Industry: {ind or 'not given'}"]


def research_role(row):
    """Research-affiliated: does research or studies at a university. An academic researcher; a data or applied
    scientist whose industry is Higher Education; or a student who names no industry other than Higher Education (a
    student whose industry is a software company works there, and is no researcher). Kept apart from sector: a web
    developer in a university's IT department is academia by sector but not a researcher (see academic_staff)."""
    dev, ind, emp = _clean(row.DevType), _clean(row.Industry), split(row.Employment)
    if dev == "Academic researcher": return True
    if dev in SCIENTIST_DEV_TYPES and ind == "Higher Education": return True
    return "Student" in emp and not (WORKING & set(emp)) and ind in (None, "Higher Education")


def academic_staff(row):
    """Technical staff employed by a university (Industry Higher Education, a developer or infrastructure role): research
    software engineers and research-computing staff, who use research infrastructure without being researchers. A
    separate facet so an audience can say "researchers or academic staff" without calling staff researchers."""
    emp = set(split(row.Employment))
    return _clean(row.Industry) == "Higher Education" and bool(WORKING & emp) and _clean(row.DevType) in STAFF_DEV_TYPES


def facets_of(row):
    """The namespaced attributes.facets object; None when the respondent gave no usable country (e.g. "Nomadic")."""
    from geo import COUNTRY_ISO2, ISO2_NAME, ISO2_REGION
    iso = COUNTRY_ISO2.get(_clean(row.Country) or "")
    if not iso: return None
    sector, basis = derive_sector(row)
    return {"country": iso, "country_name": ISO2_NAME[iso], "region": ISO2_REGION[iso], "sector": sector, "sector_basis": basis,
            "research_role": bool(research_role(row)), "academic_staff": bool(academic_staff(row)), "dev_type": _clean(row.DevType), "industry_survey": industry_of(row),
            "org_size": _clean(row.OrgSize), "employment": split(row.Employment), "main_branch": _clean(row.MainBranch),
            "ai_agents": _clean(row.AIAgents), "source": "so2025"}
