import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, garagesTable, invoicesTable } from "@workspace/db";
import { rateLimit } from "../middlewares/rateLimit";

const router: IRouter = Router();

function validInvoiceId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

router.post("/invoices", rateLimit({ keyPrefix: "invoice-create", windowMs: 60 * 60_000, max: 30 }), async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: "Authentification requise." });
  const garageId = Number(req.body?.garageId);
  const amount = Number(req.body?.amount);
  const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
  if (!Number.isInteger(garageId) || garageId <= 0 || !Number.isInteger(amount) || amount < 100 || amount > 100_000_000 || !description || description.length > 500) {
    return res.status(400).json({ error: "Données de facture invalides." });
  }
  const [garage] = await db.select().from(garagesTable).where(and(eq(garagesTable.id, garageId), eq(garagesTable.ownerId, req.user.id)));
  if (!garage) return res.status(403).json({ error: "Vous ne pouvez pas créer une facture pour ce garage." });
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [invoice] = await db.insert(invoicesTable).values({ garageId, amount, description, currency: "XAF", expiresAt, status: "issued" }).returning();
  return res.status(201).json({ invoiceId: invoice.id, amount: invoice.amount, currency: invoice.currency, description: invoice.description, garage: { id: garage.id, name: garage.name }, status: invoice.status, expiresAt: invoice.expiresAt });
});

router.get("/invoices/:invoiceId", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: "Authentification requise." });
  const rawInvoiceId = req.params.invoiceId;
  const invoiceId = Array.isArray(rawInvoiceId) ? rawInvoiceId[0] ?? "" : rawInvoiceId;
  if (!validInvoiceId(invoiceId)) return res.status(400).json({ error: "Identifiant de facture invalide." });
  const [row] = await db.select({ invoice: invoicesTable, garage: garagesTable }).from(invoicesTable).innerJoin(garagesTable, eq(garagesTable.id, invoicesTable.garageId)).where(eq(invoicesTable.id, invoiceId));
  if (!row) return res.status(404).json({ error: "Facture introuvable." });
  if (row.invoice.clientId && row.invoice.clientId !== req.user.id && row.garage.ownerId !== req.user.id) return res.status(404).json({ error: "Facture introuvable." });
  if (row.invoice.status !== "paid" && row.invoice.expiresAt.getTime() <= Date.now()) {
    await db.update(invoicesTable).set({ status: "expired" }).where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.status, row.invoice.status)));
    row.invoice.status = "expired";
  }
  return res.json({ invoiceId: row.invoice.id, amount: row.invoice.amount, currency: row.invoice.currency, description: row.invoice.description, status: row.invoice.status, expiresAt: row.invoice.expiresAt, garage: { id: row.garage.id, name: row.garage.name } });
});

router.get("/invoices/:invoiceId/status", rateLimit({ keyPrefix: "invoice-status", windowMs: 60_000, max: 30 }), async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: "Authentification requise." });
  const rawInvoiceId = req.params.invoiceId;
  const invoiceId = Array.isArray(rawInvoiceId) ? rawInvoiceId[0] ?? "" : rawInvoiceId;
  if (!validInvoiceId(invoiceId)) return res.status(400).json({ error: "Identifiant de facture invalide." });
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  if (!invoice || (invoice.clientId && invoice.clientId !== req.user.id)) return res.status(404).json({ error: "Facture introuvable." });
  return res.json({ invoiceId: invoice.id, status: invoice.status, paidAt: invoice.paidAt, expiresAt: invoice.expiresAt });
});

export default router;
