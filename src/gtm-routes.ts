/**
 * GTM phase 2's admin routes (/api/admin/onboarding/gtm/...), mounted by src/http.ts next to the campaign routes:
 * prospects and companies (src/gtm-crm.ts), Apollo (src/gtm-apollo.ts), sender identities and the reply quick
 * actions (src/gtm-outbound.ts), deals and outbound attribution (src/gtm-deals.ts). Every write, and every read that
 * returns personal data (prospects and their timelines, companies with their people and owners, deals with their
 * contacts, sender identities' addresses; Apollo search is a POST), needs the `campaigns` permission, as the replies
 * inbox does (admin-roles.ts, a DB / Clerk role, never an allow-list). Apollo's status and the outbound attribution
 * numbers stay open to any admin.
 */
import type { Request, Response, Router, RequestHandler } from "express";
import * as crm from "./gtm-crm.js";
import * as apollo from "./gtm-apollo.js";
import * as outbound from "./gtm-outbound.js";
import * as deals from "./gtm-deals.js";

export function gtmOutboundRoutes(ob: Router, o: { need: (p: "campaigns" | "read") => RequestHandler; actor: (req: Request, res: Response) => string }) {
  const { need, actor } = o;
  const id = (req: Request) => Number(req.params.id);
  const w = need("campaigns");
  // Prospects: the list, one with its timeline, import (dry run first), notes, bulk edits.
  ob.get("/gtm/prospects", w, async (_req, res) => void res.json(await crm.listProspects()));
  ob.get("/gtm/prospects/:id", w, async (req, res) => void res.json(await crm.prospectDetail(id(req))));
  ob.post("/gtm/prospects", w, async (req, res) => void res.status(201).json(await crm.createProspect(actor(req, res), req.body ?? {})));
  ob.post("/gtm/prospects/import", w, async (req, res) => void res.json(await crm.importProspects(actor(req, res), req.body ?? {})));
  // Link every prospect and company to the customers that exist now (idempotent; the first tick runs it once too).
  ob.post("/gtm/prospects/relink", w, async (req, res) => void res.json(await crm.backfillCustomerLinks(actor(req, res))));
  ob.post("/gtm/prospects/bulk", w, async (req, res) => void res.json(await crm.bulkUpdate(actor(req, res), req.body ?? {})));
  ob.post("/gtm/prospects/delete", w, async (req, res) => void res.json(await crm.deleteProspects(actor(req, res), req.body?.ids)));
  ob.put("/gtm/prospects/:id", w, async (req, res) => void res.json(await crm.updateProspect(actor(req, res), id(req), req.body ?? {})));
  ob.post("/gtm/prospects/:id/notes", w, async (req, res) => void res.status(201).json(await crm.addNote(actor(req, res), id(req), req.body?.text)));
  // Companies.
  ob.get("/gtm/companies", w, async (_req, res) => void res.json(await crm.listCompanies()));
  ob.get("/gtm/companies/:id", w, async (req, res) => void res.json(await crm.companyDetail(id(req))));
  ob.post("/gtm/companies/import", w, async (req, res) => void res.json(await crm.importCompanies(actor(req, res), req.body ?? {})));
  ob.post("/gtm/companies", w,async (req, res) => void res.status(201).json(await crm.createCompany(actor(req, res), req.body ?? {})));
  ob.put("/gtm/companies/:id", w, async (req, res) => void res.json(await crm.updateCompany(actor(req, res), id(req), req.body ?? {})));
  ob.delete("/gtm/companies/:id", w, async (req, res) => { await crm.deleteCompany(actor(req, res), id(req)); res.status(204).end(); });
  // Apollo: status (and credits), find people (no credits), import found people, enrich (credits).
  ob.get("/gtm/apollo", async (_req, res) => void res.json(await apollo.apolloStatus()));
  ob.post("/gtm/apollo/search", w, async (req, res) => void res.json(await apollo.searchPeople(req.body ?? {}, { force: req.body?.force === true })));
  ob.post("/gtm/apollo/import", w, async (req, res) => void res.json(await apollo.importFound(actor(req, res), req.body ?? {})));
  ob.post("/gtm/apollo/enrich/prospects", w, async (req, res) => void res.json(await apollo.enrichProspects(actor(req, res), req.body ?? {})));
  ob.post("/gtm/apollo/enrich/companies", w, async (req, res) => void res.json(await apollo.enrichCompanies(actor(req, res), req.body ?? {})));
  // Outbound sender identities (the outreach subdomain) and their warm-up.
  ob.get("/gtm/identities", w, async (_req, res) => void res.json(await outbound.listIdentities()));
  ob.post("/gtm/identities", w, async (req, res) => void res.status(201).json(await outbound.createIdentity(actor(req, res), req.body ?? {})));
  ob.put("/gtm/identities/:id", w, async (req, res) => void res.json(await outbound.updateIdentity(actor(req, res), id(req), req.body ?? {})));
  ob.delete("/gtm/identities/:id", w, async (req, res) => { await outbound.deleteIdentity(actor(req, res), id(req)); res.status(204).end(); });
  // The Replies inbox's quick actions: interested, not interested, unsubscribe.
  ob.post("/gtm/replies/:id/action", w, async (req, res) => void res.json(await outbound.replyAction(actor(req, res), id(req), req.body?.action)));
  // Deals: the pipeline's stages, the deals, the board's drag.
  ob.get("/gtm/deals", w, async (_req, res) => void res.json(await deals.listDeals()));
  ob.get("/gtm/deals/:id", w, async (req, res) => void res.json(await deals.dealDetail(id(req))));
  ob.put("/gtm/deal-stages", w, async (req, res) => void res.json(await deals.setStages(actor(req, res), req.body ?? {})));
  ob.post("/gtm/deals", w, async (req, res) => void res.status(201).json(await deals.createDeal(actor(req, res), req.body ?? {})));
  ob.put("/gtm/deals/:id", w, async (req, res) => void res.json(await deals.updateDeal(actor(req, res), id(req), req.body ?? {})));
  ob.post("/gtm/deals/:id/move", w, async (req, res) => void res.json(await deals.moveDeal(actor(req, res), id(req), req.body ?? {})));
  ob.delete("/gtm/deals/:id", w, async (req, res) => { await deals.deleteDeal(actor(req, res), id(req)); res.status(204).end(); });
  // Attribution: outbound as a channel, per campaign and per prospect source (first touch).
  ob.get("/gtm/attribution/outbound", async (req, res) => void res.json(await deals.outboundAttribution(req.query)));
}
