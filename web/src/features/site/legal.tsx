// /terms and /privacy: the legal pages, written to match what the product does (docs/security.md, src/email.ts,
// src/billing.ts). Drafts pending legal review: the company's legal name, address and governing law are placeholders
// in [brackets] until counsel fills them in; the note at the top says so.
import type { ReactNode } from 'react';
import Link from 'next/link';

export const COMPANY = '[Company legal name]';
export const ADDRESS = '[Registered address]';
export const LAW = '[Governing law and courts]';
export const CONTACT = 'hello@octillion.useimmaculate.com';
export const UPDATED = '22 October 2026';

export interface LegalSection { title: string; body: ReactNode[] }

const mail = <a className='text-primary underline-offset-4 hover:underline' href={`mailto:${CONTACT}`}>{CONTACT}</a>;

export function LegalPage({ title, intro, sections }: { title: string; intro: ReactNode; sections: LegalSection[] }) {
  return (
    <article className='mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20'>
      <p className='rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground'>
        Draft pending legal review. Text in [brackets] is filled in before launch.
      </p>
      <h1 className='mt-8 text-3xl font-semibold tracking-tight sm:text-4xl'>{title}</h1>
      <p className='text-muted-foreground mt-2 text-sm'>Last updated {UPDATED}</p>
      <div className='text-muted-foreground mt-6 text-base leading-relaxed'>{intro}</div>
      <ol className='mt-10 flex flex-col gap-10'>
        {sections.map((s, i) => (
          <li key={s.title} id={s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')} className='scroll-mt-24'>
            <h2 className='text-xl font-semibold tracking-tight'><span className='text-muted-foreground mr-2 tabular-nums'>{i + 1}.</span>{s.title}</h2>
            <div className='text-muted-foreground mt-3 flex flex-col gap-3 leading-relaxed [&_li]:ml-5 [&_li]:list-disc [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1.5'>
              {s.body.map((b, j) => (typeof b === 'string' ? <p key={j}>{b}</p> : <div key={j}>{b}</div>))}
            </div>
          </li>
        ))}
      </ol>
      <p className='text-muted-foreground mt-14 border-t pt-6 text-sm'>
        Questions: {mail}. See also the <Link className='text-primary underline-offset-4 hover:underline' href={title === 'Privacy Policy' ? '/terms' : '/privacy'}>{title === 'Privacy Policy' ? 'Terms of Service' : 'Privacy Policy'}</Link>.
      </p>
    </article>
  );
}

export const TERMS: { intro: ReactNode; sections: LegalSection[] } = {
  intro: <p>These terms are an agreement between {COMPANY} (&quot;Octillion&quot;, &quot;we&quot;) and the organization that signs up for Octillion (&quot;you&quot;). By creating an account, connecting an AI client to Octillion or subscribing to a plan, you agree to them on behalf of your organization.</p>,
  sections: [
    { title: 'The service', body: [
      'Octillion measures how often AI coding agents choose a developer product during real programming tasks. We run coding agents on tasks in isolated sandboxes, record what they do, score whether they adopted, recommended or skipped your product, and report the results in the web app and over our MCP server.',
      'The service is offered in early access. Features, supported agents and limits may change, and we may pause a feature to keep the service reliable or secure.'] },
    { title: 'Accounts', body: [
      'Accounts are invite-only. You are responsible for the people you invite, their roles, and keeping sign-in credentials and API keys secure. Tell us at once if you think an account or key has been misused.',
      'You must be able to bind your organization to these terms.'] },
    { title: 'Plans, usage and payment', body: [
      'Paid plans are billed in advance through Stripe. A plan includes a monthly allowance for model usage; usage beyond what a plan includes is billed as the plan states. When an allowance is used up, new simulations do not start until it resets or is raised.',
      'Prices exclude taxes unless stated. Fees already paid are not refundable except where the law requires it or we say otherwise in writing. You can cancel a plan at any time; it stays active until the end of the period you paid for.',
      'We may change prices for future periods with at least 30 days’ notice by email.'] },
    { title: 'Your content', body: [
      'You keep all rights to what you bring: product descriptions, tasks, personas, harness specifications, and the results and transcripts of your runs (“your content”). You give us a limited licence to host, process and display your content only to provide the service to you.',
      'Your private content is never shown to, used for or shared with another customer, and never added to our public library unless you publish it there yourself. When you publish a task or persona to the library and we accept it, you give us a perpetual, worldwide licence to use it in the library.',
      'You are responsible for having the rights to the content you upload, and for not uploading secrets, personal data you are not allowed to share, or content that breaks the law.'] },
    { title: 'Our content and the public library', body: [
      'The software, the curated task library, the shared developer profiles and the reports’ format belong to us or our licensors. You may use reports and exports for your organization’s own purposes, including sharing them with your team, customers and investors.'] },
    { title: 'Acceptable use', body: [
      <ul key='u'>
        <li>Do not try to reach another customer’s data, our credentials or the infrastructure the agents run on.</li>
        <li>Do not use tasks, personas or harnesses to make agents attack systems, send spam, mine cryptocurrency or do anything unlawful.</li>
        <li>Do not resell the service or use it to build a competing benchmark without our written consent.</li>
        <li>Do not interfere with the service or circumvent its limits.</li>
      </ul>,
      'We may suspend an account that breaks these rules, telling you why unless the law or security prevents it.'] },
    { title: 'Third-party AI models and agents', body: [
      'Simulations run third-party coding agents and AI models. Their output can be wrong, and agents choose tools on their own. Results are measurements of agent behaviour on the tasks we ran, not guarantees of how any agent will behave elsewhere.'] },
    { title: 'Confidentiality and security', body: [
      'Each party keeps the other’s non-public information confidential and uses it only to perform under these terms. Our security measures are described in the Privacy Policy, including per-organization encryption of private tasks and personas.'] },
    { title: 'Warranties and liability', body: [
      'The service is provided “as is” during early access. To the extent the law allows, we disclaim implied warranties of merchantability, fitness for a particular purpose and non-infringement.',
      'To the extent the law allows, neither party is liable for indirect, incidental, special or consequential damages, or lost profits, and each party’s total liability under these terms is limited to the fees you paid in the 12 months before the claim. These limits do not apply to your payment obligations, to breaches of confidentiality, or to liability that cannot be limited by law.'] },
    { title: 'Ending the agreement', body: [
      'You can close your account at any time. We can end these terms with 30 days’ notice, or at once if you materially breach them and do not fix the breach within 10 days of notice.',
      'When an account is closed, we delete its data as described in the Privacy Policy. Sections on content licences you granted for published library items, confidentiality, liability and governing law survive.'] },
    { title: 'Changes and general terms', body: [
      'We may update these terms; for material changes we give at least 30 days’ notice by email, and the update applies from the next billing period. ',
      `These terms are governed by ${LAW}. ${COMPANY}, ${ADDRESS}.`] },
  ],
};

export const PRIVACY: { intro: ReactNode; sections: LegalSection[] } = {
  intro: <p>This policy explains what personal data {COMPANY} (&quot;Octillion&quot;, &quot;we&quot;) collects when you use octillion.useimmaculate.com, the Octillion web app and its MCP server, why, who processes it for us, and your choices. For the data you upload about your products and runs, we act as your processor and follow your instructions.</p>,
  sections: [
    { title: 'What we collect', body: [
      <ul key='c'>
        <li><strong className='text-foreground'>Account data:</strong> name, email address, organization and role, through our sign-in provider.</li>
        <li><strong className='text-foreground'>Access requests:</strong> what you enter on the early-access form (name, email, company, product links, goals) and where you came from (referrer, campaign tags, country and city from your IP).</li>
        <li><strong className='text-foreground'>Your content:</strong> products, tasks, personas, harness specifications, simulation transcripts, results and reports.</li>
        <li><strong className='text-foreground'>Billing data:</strong> plan, invoices and payment status. Card details go straight to Stripe; we never see or store them.</li>
        <li><strong className='text-foreground'>Usage data:</strong> which pages and tools you use, MCP tool calls, errors, and security logs of staff access. Questions you ask the docs assistant are not stored.</li>
      </ul>] },
    { title: 'Why we use it', body: [
      <ul key='w'>
        <li>To run the service: sign you in, run your simulations, show your results, and bill your plan (performing our contract with you).</li>
        <li>To keep it secure and reliable: detect abuse, investigate errors, and alert our operators when sessions fail (our legitimate interest).</li>
        <li>To improve the product and talk to you about it: product analytics and service emails such as budget alerts and replies to your requests (legitimate interest; you can opt out of non-essential emails).</li>
      </ul>,
      'We do not sell personal data, and we do not use your private content to train AI models.'] },
    { title: 'Who processes it for us', body: [
      'We use these subprocessors, each bound by a data processing agreement:',
      <ul key='p'>
        <li>Vercel (hosting), Neon (database), Cloudflare (file storage and some AI models), ClickHouse (transcript storage), boat.dev (agent sandboxes).</li>
        <li>Clerk (sign-in), Stripe (payments), Resend (email), PostHog (product analytics).</li>
        <li>AI model and coding-agent providers that simulations and research run on, including Anthropic, OpenAI, Google and Alibaba Cloud. They receive task prompts and the code the agents work on, through our gateway, never your account details.</li>
      </ul>,
      'Some of them process data outside your country, including in the United States; transfers rely on standard contractual clauses or equivalent safeguards.'] },
    { title: 'How we protect it', body: [
      'Each organization’s data is scoped to that organization in every query and tool, and checked by automated tests. Private tasks and personas are encrypted at rest with a key per organization. Coding agents run in isolated, single-use sandboxes and never receive your account credentials. Staff access to admin tools is logged.'] },
    { title: 'How long we keep it', body: [
      'We keep your data while your account is open. When an organization is deleted, we revoke its keys, delete its database rows, transcripts and stored files, and keep only counts without content. Database backups that still contain deleted rows expire within 30 days. Billing records are kept as long as tax law requires.'] },
    { title: 'Cookies', body: [
      'We use cookies needed to keep you signed in, and product-analytics cookies to understand how the app is used. We do not use advertising cookies.'] },
    { title: 'Your rights', body: [
      <>Depending on where you live, you may have the right to access, correct, delete or export your personal data, to object to or restrict its use, and to complain to your data protection authority. To use them, email {mail}; we reply within 30 days. An organization’s owners can delete the organization and its data from the account.</>] },
    { title: 'Changes and contact', body: [
      'We will post changes here and, for material ones, email account owners before they take effect.',
      <>Controller: {COMPANY}, {ADDRESS}. Contact: {mail}.</>] },
  ],
};
