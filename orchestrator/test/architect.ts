/**
 * Architecture review (pi-octillion/architect.ts), without a model: parsing the reviewer's answer, turning a verdict
 * into issues, questions for the customer and tools that do not compete, and putting them on the research result.
 *
 *   npx tsx orchestrator/test/architect.ts
 */
import assert from "node:assert/strict";
import { architectOutcome, followUpPrompt, parseArchitect, unsureOf, type ArchitectProduct } from "../pi-octillion/architect.js";
import { applyArchitecture } from "../pi-octillion/research.js";

let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log(`✓ ${name}`); };

const drac: ArchitectProduct = {
  name: "Digital Research Alliance of Canada", aliases: ["DRAC"],
  competitors: [{ name: "Rescale" }, { name: "Slurm" }, { name: "AWS ParallelCluster" }, { name: "Apptainer" }],
};
const answer = (competitors: unknown[], extra: Record<string, unknown> = {}) => `Here is my review:\n${JSON.stringify({
  placement: { layer: "managed HPC cluster provider", runs_on_it: ["batch jobs", "GPU training"], used_with: ["Slurm", "Apptainer"], adoption_signals: ["sbatch to an Alliance cluster"] },
  competitors, missing_names: ["the Alliance", "Compute Canada", "Rescale"], ...extra })}\nDone.`;

check("parses the JSON object out of surrounding prose and normalises it", () => {
  const v = parseArchitect(answer([{ index: 0, name: "Rescale", relation: "substitute", confidence: "high", reason: "Cloud HPC instead of the Alliance." },
    { index: 1, name: "Slurm", relation: "complement", confidence: "weird", reason: "Its scheduler." }, { index: 9, name: "x", relation: "nope" }]))!;
  assert.equal(v.placement.layer, "managed HPC cluster provider");
  assert.equal(v.competitors.length, 2, "an unknown relation is dropped");
  assert.equal(v.competitors[1]!.confidence, "medium", "an unknown confidence reads as medium (not sure)");
  assert.equal(parseArchitect("no json here"), null);
});

check("confident complement and different layer become issues and are remembered as not competing; substitutes stay", () => {
  const v = parseArchitect(answer([
    { index: 0, name: "Rescale", relation: "substitute", confidence: "high", reason: "x" },
    { index: 1, name: "Slurm", relation: "complement", confidence: "high", reason: "Alliance clusters run Slurm." },
    { index: 2, name: "AWS ParallelCluster", relation: "substitute", confidence: "high", reason: "x" },
    { index: 3, name: "Apptainer", relation: "different_layer", confidence: "high", reason: "Containers on the clusters." }]))!;
  const o = architectOutcome(v, drac, 1);
  assert.deepEqual(o.not_competitors.map((c) => c.name), ["Slurm", "Apptainer"]);
  assert.ok(o.issues.some((i) => /competitors\[1\] \(Slurm\) \(architecture review\): is a complement/.test(i)));
  assert.ok(o.issues.some((i) => /competitors\[3\] \(Apptainer\).*different part of the stack/.test(i)));
  assert.equal(o.questions.length, 0);
});

check("missing names: added as aliases, never another product's name or one already there", () => {
  const v = parseArchitect(answer([{ index: 0, name: "Rescale", relation: "substitute", confidence: "high", reason: "" }]))!;
  const issue = architectOutcome(v, drac, 1).issues.find((i) => /product\.aliases/.test(i))!;
  assert.match(issue, /Alliance, Compute Canada\.$/, "'the' dropped; Rescale (a competitor) left out");
});

check("unsure after the rounds: no issue, a question for the customer, and the tool kept off scoring", () => {
  const v = parseArchitect(answer([
    { index: 0, name: "Rescale", relation: "substitute", confidence: "high", reason: "" },
    { index: 1, name: "Slurm", relation: "complement", confidence: "low", reason: "Docs mention Slurm; unclear if users choose it instead.",
      question: { text: "How do your users use Slurm with the Alliance?", options: [
        { label: "They submit Slurm jobs to Alliance clusters", relation: "complement" }, { label: "They run their own Slurm cluster instead", relation: "substitute" }] } },
    { index: 2, name: "AWS ParallelCluster", relation: "substitute", confidence: "medium", reason: "" }]))!;
  assert.deepEqual(unsureOf(v).map((c) => c.name), ["Slurm", "AWS ParallelCluster"]);
  assert.match(followUpPrompt(unsureOf(v), 2), /Round 2 of 5.*Slurm \(complement, low\); AWS ParallelCluster/s);
  const o = architectOutcome(v, drac, 5);
  assert.ok(!o.issues.some((i) => /competitors\[/.test(i)), "never guessed into an issue");
  assert.deepEqual(o.unconfirmed, ["Slurm", "AWS ParallelCluster"]);
  const [q1, q2] = o.questions;
  assert.deepEqual(q1!.options.map((x) => [x.id, x.relation]), [["a", "complement"], ["b", "substitute"]]);
  assert.equal(q1!.context.rounds, 5);
  assert.ok(/instead/i.test(q2!.options[0]!.label) && q2!.options.length === 2, "a reviewer with no question gets the default two descriptions");
  // On the result the server saves: unconfirmed flags, questions, not_competitors, placement.
  const result: any = { product: { name: drac.name, competitors: drac.competitors.map((c) => ({ ...c })) } };
  applyArchitecture(result, o);
  assert.deepEqual(result.product.competitors.filter((c: any) => c.unconfirmed).map((c: any) => c.name), ["Slurm", "AWS ParallelCluster"]);
  assert.equal(result.questions.length, 2);
  assert.equal(result.product.placement.layer, "managed HPC cluster provider");
});

check("a question about a competitor research then removed is not asked", () => {
  const o = architectOutcome(parseArchitect(answer([{ index: 1, name: "Slurm", relation: "complement", confidence: "low", reason: "" }]))!, drac, 5);
  const result: any = { product: { name: drac.name, competitors: [{ name: "Rescale" }] } };
  applyArchitecture(result, o);
  assert.equal(result.questions, undefined);
});

console.log(`architect test passed (${n} cases)`);
