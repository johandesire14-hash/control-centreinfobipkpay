import { Router, Request, Response } from "express";
const router = Router();

router.post("/pay", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: "Authentification requise." });
  }

  try {
    const { amount, externalId, description } = req.body;
    const rawPhone = req.body.phoneNumber || req.body.phone || "";
    const rawProvider = req.body.provider || "";
    const providerInput = String(rawProvider).trim().toUpperCase();
    let kpayProvider = providerInput.includes("AIRTEL")
      ? "AIRTEL_COG"
      : "MTN_MOMO_COG";
    const digits = String(rawPhone).replace(/\D/g, "");
    let phoneNumber = digits.length === 9 ? "242" + digits : digits;
    const cleanAmount = Number(amount) || 0;
    const cleanExternalId = externalId || `INV-${Date.now()}`;
    const cleanDescription = description || "Paiement WapiGarage";
    const payload = {
      amount: cleanAmount,
      phoneNumber,
      provider: kpayProvider,
      externalId: cleanExternalId,
      description: cleanDescription,
    };
    console.log("🚀 [COUPABLE NEUTRALISÉ] PAYLOAD FINAL KPAY :", payload);
    const baseUrl = process.env.KPAY_API_URL || "https://admin.kpay.site";
    const apiKey = process.env.KPAY_API_KEY || "";
    const secretKey = process.env.KPAY_SECRET_KEY || "";
    const kpayRes = await fetch(`${baseUrl}/api/v1/payments/init`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        "X-Secret-Key": secretKey,
      },
      body: JSON.stringify(payload),
    });
    const responseText = await kpayRes.text();
    console.log("📡 [KPAY STATUS & REPONSE]:", kpayRes.status, responseText);
    if (!kpayRes.ok) {
      return res.status(kpayRes.status).json({
        error: "Échec du paiement KPay",
        details: responseText,
      });
    }
    let kpayData;
    try {
      kpayData = JSON.parse(responseText);
    } catch (e) {
      kpayData = { success: true, raw: responseText };
    }
    return res.status(200).json(kpayData);
  } catch (err) {
    console.error("❌ [KPAY ERROR]:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
