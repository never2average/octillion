"""Developer personas grounded in the Stack Overflow Developer Survey 2025 (ODbL).

Each persona is one real respondent's joint attributes (role, experience, org size, industry, remote, languages, web
frameworks, purchase influence, AI-agent use), sampled at random from professional developers who use AI agents at
work, so the persona set follows the survey's real distribution and correlations. gpt-6.1-sol writes the narrative and
answering instructions. Databases, platforms and AI vendors are described generically, never named: personas answer a
coding agent blind, and must not steer it toward or away from any vendor. A check rejects any persona that names one.
  python so_personas.py OUT.json N
"""
import glob, os, json, random, re, sys
from concurrent.futures import ThreadPoolExecutor
import pyarrow.parquet as pq
import llm

out_path, n = sys.argv[1], int(sys.argv[2])
p = os.environ["SO_SURVEY_PARQUET"]
df = pq.read_table(p).to_pandas()
pool = df[(df.MainBranch == "I am a developer by profession")
          & df.Employment.isin(["Employed", "Independent contractor, freelancer, or self-employed"])
          & df.AIAgents.fillna("").str.startswith("Yes")
          & df.DevType.notna() & df.WorkExp.notna() & df.LanguageHaveWorkedWith.notna()]
print(f"eligible respondents: {len(pool)} of {len(df)}", flush=True)
rows = pool.sample(n=n, random_state=20261011)

split = lambda v: [x.strip() for x in str(v).split(";") if x and str(v) != "nan"]
# Vendor names respondents could pick for databases, platforms and AI models: personas must never name these.
vendors = set()
for col in ["DatabaseHaveWorkedWith", "PlatformHaveWorkedWith", "AIModelsHaveWorkedWith", "OfficeStackAsyncHaveWorkedWith",
            "CommPlatformHaveWorkedWith"]:
    for v in df[col].dropna():
        vendors.update(split(v))
STOP = {"Other", "None", "Bash/Shell (all shells)", "Docker", "npm", "Homebrew", "Make", "Kubernetes"}
vendor_terms = set()
for v in vendors - STOP:
    for part in re.split(r"[()/]", v):
        part = part.strip()
        if len(part) >= 4 and not part.lower() in {"models", "chatbot", "reasoning", "general", "purpose", "flash", "build tool", "image generating models"}:
            vendor_terms.add(part)
vendor_re = re.compile(r"\b(" + "|".join(sorted((re.escape(t) for t in vendor_terms), key=len, reverse=True)) + r")\b", re.I)

SYSTEM = """You write developer personas for a simulation. A coding agent works on a task for this developer; when the agent
asks a question, an orchestrator answers in character using your persona. Ground everything in the survey attributes given;
do not invent seniority, company size or stack beyond them.
Hard rules:
- Never name any database, cloud/hosting platform, SaaS tool, observability/payments/auth/email vendor, or AI model/vendor.
  Describe them generically ("an existing relational database", "a major public cloud", "a hosted error-tracking tool").
- You MAY name programming languages and web frameworks from the attributes (they define the codebase).
- Invent a plausible first name + last initial matching nothing real (e.g. "Priya S."). No real people.
- instructions: 3-6 sentences on how this developer answers a coding agent: brevity, what they care about (cost, compliance,
  time-to-ship, team conventions, scale), what they defer to the agent. They never suggest a specific vendor or package;
  if the agent offers options, they choose by their constraints and may ask for the simplest/cheapest/most standard one.
Return JSON: {"name", "summary" (1-2 sentences), "attributes": {"role", "experience_years" (int), "company_size",
"industry", "work_mode", "stack" (languages + web frameworks only), "constraints" (3-5 short items), "tone",
"buying_influence", "ai_agent_use"}, "instructions"}"""


def build(row):
    facts = {
        "dev_type": row.DevType, "years_professional": row.WorkExp, "years_coding": row.YearsCode,
        "org_size": row.OrgSize, "ic_or_manager": row.ICorPM, "industry": row.Industry, "remote": row.RemoteWork,
        "country": row.Country, "purchase_influence": row.PurchaseInfluence, "ai_agents": row.AIAgents,
        "languages": split(row.LanguageHaveWorkedWith), "web_frameworks": split(row.WebframeHaveWorkedWith),
        "database_count": len(split(row.DatabaseHaveWorkedWith)), "platforms_generic": generic_platforms(split(row.PlatformHaveWorkedWith)),
    }
    facts = {k: (None if str(v) == "nan" else v) for k, v in facts.items()}
    for attempt in range(3):
        extra = "" if attempt == 0 else "\nYour previous draft named a vendor. Remove every vendor name."
        v = llm.chat_json("gpt-6.1-sol", SYSTEM, "Survey respondent attributes:\n" + json.dumps(facts, default=str) + extra, 1500)
        text = json.dumps({k: v.get(k) for k in ("name", "summary", "instructions")}) + json.dumps((v.get("attributes") or {}).get("constraints"))
        hit = vendor_re.search(text)
        if v.get("name") and v.get("instructions") and not hit:
            v["attributes"]["survey"] = {"source": "Stack Overflow Developer Survey 2025", "response_id": int(row.ResponseId),
                                         "license": "ODbL-1.0"}
            v["id"] = f"so25-{int(row.ResponseId)}"
            return v
    return None


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


with ThreadPoolExecutor(8) as ex:
    personas = [p for p in ex.map(build, (r for _, r in rows.iterrows())) if p]
json.dump(personas, open(out_path, "w"), indent=2, ensure_ascii=False)
print(f"wrote {len(personas)} personas; spend so far {llm.spent()}")
