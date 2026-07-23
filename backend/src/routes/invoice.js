const express = require("express");
const { ethers } = require("ethers");
const db = require("../lib/db");

const router = express.Router();

// POST /invoice/verify
// body: { invoice: { policyId, agent, amount, resource, nonce }, signature }
//
// The provider agent signs a canonical hash of its invoice with the wallet
// key tied to its on-chain agent identity. The consumer (or this service,
// on the consumer's behalf) verifies that signature recovers to the expected
// wallet before any payment is attempted — this is what stops a spoofed or
// tampered invoice from ever reaching checkAndDeduct().
//
// MVP note: identity lookup here checks the wallet against agents already
// registered on a policy. Swap `isKnownAgent()` for a real ERC-8004 identity
// registry read (via Onchain OS) once that endpoint is wired up — the
// signature-verification logic itself does not change.
router.post("/invoice/verify", (req, res) => {
  const { invoice, signature } = req.body || {};
  if (!invoice || !signature) {
    return res.status(400).json({ error: "invoice and signature are required" });
  }
  const { policyId, agent, amount, resource, nonce } = invoice;
  if (typeof policyId !== "number" || !agent || typeof amount !== "number" || !resource || !nonce) {
    return res.status(400).json({ error: "invoice requires policyId, agent, amount, resource, nonce" });
  }

  const message = JSON.stringify({ policyId, agent, amount, resource, nonce });

  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch (err) {
    return res.status(400).json({ verified: false, reason: "malformed signature", detail: err.message });
  }

  if (recovered.toLowerCase() !== agent.toLowerCase()) {
    return res.status(200).json({ verified: false, reason: "signature does not match claimed agent wallet" });
  }

  if (!isKnownAgent(policyId, agent)) {
    return res.status(200).json({ verified: false, reason: "agent wallet not found in identity registry for this policy" });
  }

  res.json({ verified: true, recovered, policyId, agent });
});

function isKnownAgent(policyId, agent) {
  const row = db.prepare("SELECT 1 FROM agent_budgets WHERE policy_id = ? AND agent = ? AND active = 1").get(policyId, agent);
  return Boolean(row);
}

module.exports = router;
