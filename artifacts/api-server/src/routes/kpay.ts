import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  garagesTable,
  invoicesTable,
  kpayPaymentsTable,
} from "@workspace/db";
import { rateLimit } from "../middlewares/rateLimit";

const router: IRouter = Router();

type PaymentBody = {
  invoiceId?: unknown;
  phoneNumber?: unknown;
  phone?: unknown;
  provider?: unknown;
};

type KPayWebhookBody = {
  externalId?: unknown;
  transactionId?: unknown;
  status?: unknown;
  success?: unknown;
  amount?: unknown;
  currency?: unknown;
};

function normalizePhone(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 9) return `242${digits}`;
  if (digits.length === 12 && digits.startsWith("242")) return digits;
  return null;
}

function normalizeProvider(value: unknown): "AIRTEL_COG" | "MTN_MOMO_COG" | null {
  const provider = String(value ?? "").trim().toUpperCase();
  if (provider.includes("AIRTEL")) return "AIRTEL_COG";
  if (provider.includes("MTN")) return "MTN_MOMO_COG";
  return null;
}

function invoiceIsExpired(invoice: { expiresAt: Date; status: string }) {
  return invoice.expiresAt.getTime() <= Date.now() || invoice.status === "expired";
}

function signatureMatches(rawBody: Buffer, signature: string | undefined, secret: string) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signature.replace(/^sha256=/i, "").trim();
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

router.post("/pay", rateLimit({ keyPrefix: "kpay-pay", windowMs: 60_000, max: 5 }), async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: "Authentification requise." });
  }

  const body = req.body as PaymentBody;
  const invoiceId = typeof body.invoiceId === "string" ? body.invoiceId.trim() : "";
  const phoneNumber = normalizePhone(body.phoneNumber ?? body.phone);
  const provider = normalizeProvider(body.provider);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invoiceId)) {
    return res.status(400).json({ error: "Identifiant de facture invalide." });
  }
  if (!phoneNumber) return res.status(400).json({ error: "Numéro de téléphone invalide." });
  if (!provider) return res.status(400).json({ error: "Fournisseur Mobile Money invalide." });

  const baseUrl = process.env.KPAY_API_URL || "https://admin.kpay.site";
  const apiKey = process.env.KPAY_API_KEY;
  const secretKey = process.env.KPAY_SECRET_KEY;
  if (!apiKey || !secretKey) {
    req.log?.error("KPay server credentials are not configured");
    return res.status(503).json({ error: "Paiement temporairement indisponible." });
  }

  try {
    const [invoice] = await db
      .select({ invoice: invoicesTable, garage: garagesTable })
      .from(invoicesTable)
      .innerJoin(garagesTable, eq(garagesTable.id, invoicesTable.garageId))
      .where(eq(invoicesTable.id, invoiceId));

    if (!invoice) return res.status(404).json({ error: "Facture introuvable." });
    if (invoice.invoice.clientId && invoice.invoice.clientId !== req.user.id) {
      return res.status(403).json({ error: "Cette facture ne vous est pas destinée." });
    }
    if (invoiceIsExpired(invoice.invoice)) {
      await db.update(invoicesTable).set({ status: "expired" }).where(eq(invoicesTable.id, invoiceId));
      return res.status(409).json({ error: "Cette facture a expiré." });
    }
    if (["paid", "cancelled"].includes(invoice.invoice.status)) {
      return res.status(409).json({ error: "Cette facture ne peut plus être payée." });
    }

    const existing = await db
      .select()
      .from(kpayPaymentsTable)
      .where(and(eq(kpayPaymentsTable.invoiceId, invoiceId), eq(kpayPaymentsTable.status, "PENDING")));
    if (existing[0]) {
      return res.status(202).json({
        status: "pending",
        invoiceId,
        externalId: existing[0].externalId,
      });
    }

    const externalId = `WAPI-${invoiceId}-${crypto.randomUUID()}`;
    const [claimedInvoice] = await db
      .update(invoicesTable)
      .set({ status: "pending" })
      .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.status, invoice.invoice.status)))
      .returning();
    if (!claimedInvoice) return res.status(409).json({ error: "Facture déjà en cours de paiement." });

    await db.insert(kpayPaymentsTable).values({
      invoiceId,
      externalId,
      amount: String(invoice.invoice.amount),
      grossAmount: invoice.invoice.amount,
      netAmount: Math.max(0, invoice.invoice.amount - 500),
      provider,
      phoneNumber,
      description: invoice.invoice.description || `Facture ${invoiceId}`,
      clientId: req.user.id,
      garageId: invoice.invoice.garageId,
      status: "PENDING",
    });

    const kpayRes = await fetch(`${baseUrl}/api/v1/payments/init`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        "X-Secret-Key": secretKey,
      },
      body: JSON.stringify({
        amount: invoice.invoice.amount,
        phoneNumber,
        provider,
        externalId,
        description: invoice.invoice.description || `Facture ${invoiceId}`,
      }),
    });

    const responseText = await kpayRes.text();
    if (!kpayRes.ok) {
      await db.update(kpayPaymentsTable).set({ status: "FAILED" }).where(eq(kpayPaymentsTable.externalId, externalId));
      await db.update(invoicesTable).set({ status: "failed" }).where(eq(invoicesTable.id, invoiceId));
      return res.status(502).json({ error: "Échec de l'initialisation du paiement." });
    }

    return res.status(202).json({
      status: "pending",
      invoiceId,
      externalId,
      provider,
      amount: invoice.invoice.amount,
      currency: invoice.invoice.currency,
      garage: { id: invoice.garage.id, name: invoice.garage.name },
      kpay: (() => {
        try { return JSON.parse(responseText); } catch { return undefined; }
      })(),
    });
  } catch (error) {
    req.log?.error({ err: error }, "KPay payment initialization failed");
    return res.status(500).json({ error: "Erreur serveur pendant le paiement." });
  }
});

router.post("/webhook", rateLimit({ keyPrefix: "kpay-webhook", windowMs: 60_000, max: 120 }), async (req: Request, res: Response) => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const secret = process.env.KPAY_WEBHOOK_SECRET || process.env.KPAY_SECRET_KEY || "";
  const signature = String(req.header("x-kpay-signature") || req.header("x-signature") || "");
  if (!rawBody || !signatureMatches(rawBody, signature, secret)) {
    return res.status(401).json({ error: "Signature webhook invalide." });
  }

  const payload = req.body as KPayWebhookBody;
  const externalId = typeof payload.externalId === "string" ? payload.externalId : "";
  if (!externalId) return res.status(400).json({ error: "Référence de paiement absente." });

  const normalizedStatus = String(payload.status ?? "").toUpperCase();
  const isPaid = payload.success === true || ["SUCCESS", "SUCCEEDED", "PAID", "COMPLETED"].includes(normalizedStatus);
  const isFailed = ["FAILED", "FAILURE", "DECLINED", "CANCELLED", "EXPIRED"].includes(normalizedStatus);

  try {
    const [payment] = await db.select().from(kpayPaymentsTable).where(eq(kpayPaymentsTable.externalId, externalId));
    if (!payment) return res.status(404).json({ error: "Paiement inconnu." });
    if (payment.status === "PAID" || payment.status === "FAILED") return res.status(200).json({ ok: true, idempotent: true });

    const transactionId = typeof payload.transactionId === "string" ? payload.transactionId : payment.transactionId;
    if (isPaid) {
      const webhookAmount = payload.amount == null ? Number(payment.amount) : Number(payload.amount);
      if (!Number.isFinite(webhookAmount) || webhookAmount !== Number(payment.amount)) {
        return res.status(409).json({ error: "Montant webhook incohérent." });
      }
      await db.transaction(async (tx) => {
        await tx.update(kpayPaymentsTable).set({ status: "PAID", transactionId, paidAt: new Date(), rawWebhookPayload: payload }).where(and(eq(kpayPaymentsTable.id, payment.id), eq(kpayPaymentsTable.status, "PENDING")));
        await tx.update(invoicesTable).set({ status: "paid", paidAt: new Date(), kpayTransactionId: transactionId }).where(and(eq(invoicesTable.id, payment.invoiceId), eq(invoicesTable.status, "pending")));
      });
    } else if (isFailed) {
      await db.transaction(async (tx) => {
        await tx.update(kpayPaymentsTable).set({ status: "FAILED", transactionId, rawWebhookPayload: payload }).where(and(eq(kpayPaymentsTable.id, payment.id), eq(kpayPaymentsTable.status, "PENDING")));
        await tx.update(invoicesTable).set({ status: "failed" }).where(and(eq(invoicesTable.id, payment.invoiceId), eq(invoicesTable.status, "pending")));
      });
    } else {
      return res.status(202).json({ ok: true, ignored: true });
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "KPay webhook processing failed");
    return res.status(500).json({ error: "Webhook non traité." });
  }
});

export default router;
