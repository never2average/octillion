# Sources and licenses

The curated vault is built by [`vault/build`](../build/README.md). Both collections are derived from public data and
written by `gpt-6.1-sol` under rules that keep them blind (no vendor, hosted-service or package names).

## Task library (`tasks.json`)

Derived from **WildChat-4.8M** (Allen Institute for AI), https://huggingface.co/datasets/allenai/WildChat-4.8M,
licensed under the **Open Data Commons Attribution License (ODC-BY 1.0)**. Real first messages from English
conversations were filtered to software tasks where a third-party tool choice naturally arises, then rewritten blind for
a starter project. Each task records its source conversation hash and the vendors the original message named.

> Zhao, W., Ren, X., Hessel, J., Cardie, C., Choi, Y., Deng, Y. WildChat: 1M ChatGPT Interaction Logs in the Wild. ICLR 2024.

## Developer profiles (`profiles.json`)

Grounded in the **Stack Overflow Developer Survey 2025**, https://survey.stackoverflow.co/, licensed under the
**Open Database License (ODbL 1.0)**. Each profile is one randomly sampled respondent (professional developers who use
AI agents at work) whose joint attributes (role, experience, organization size, industry, work mode, languages, web
frameworks, purchase influence, AI-agent use) were kept as reported; the name, narrative and answering instructions are
written by the model. Each profile records the survey `ResponseId` it came from. The profiles are a derivative of the
survey data and are made available under ODbL 1.0.

Data obtained via the Hugging Face mirror `yeper/stack-overflow-developer-survey` (`survey_2025.parquet`).
