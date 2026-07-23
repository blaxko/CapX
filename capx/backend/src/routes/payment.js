const express = require("express");
const db = require("../lib/db");
const { LIVE, contract } = require("../lib/chain");

const router = express.Router();

// POST /payment/check
// body: { policyId, agent, amount }
// This is the A2MCP pay-per-call endpoint. Any orchestrator/sub-agent calls
// this before settling a payment. Returns 200 + remaining budgets on success,
// or 402/409 with a clear reason on rejection — never a silent partial charge.
router.post("/payment/check", async (req, res) => {
  const { policyId, agent, amount } = req.body || {};

  if (typeof policyId !== "number" || !agent || typeof amount !== "number" || amount <= 0) {
    return res.status(400).json({ error: "policyId (number), agent (address), and a positive numeric amount are required" });
  }

  const policy = db.prepare("SELECT * FROM policies WHERE id = ?").get(policyId);
  if (!policy) return res.status(404).json({ error: "policy not found" });
  if (policy.paused) {
    return res.status(409).json({ approved: false, reason: "policy is paused" });
  }

  const budget = db.prepare("SELECT * FROM agent_budgets WHERE policy_id = ? AND agent = ?").get(policyId, agent);
  if (!budget || !budget.active) {
    return res.status(404).json({ approved: false, reason: "agent is not registered under this policy" });
  }

  if (budget.spent + amount > budget.soft_cap) {
    db.prepare(`
      INSERT INTO events (policy_id, agent, type, amount, reason) VALUES (?, ?, 'BudgetExceeded', ?, 'agent soft cap exceeded')
    `).run(policyId, agent, amount);
    return res.status(402).json({ approved: false, reason: "agent soft cap exceeded" });
  }
  if (policy.spent + amount > policy.global_budget) {
    db.prepare(`
      INSERT INTO events (policy_id, agent, type, amount, reason) VALUES (?, ?, 'BudgetExceeded', ?, 'global hard cap exceeded')
    `).run(policyId, agent, amount);
    return res.status(402).json({ approved: false, reason: "global hard cap exceeded" });
  }

  let txHash = null;
  let remainingGlobal, remainingAgent;

  if (LIVE) {
    try {
      const tx = await contract.checkAndDeduct(policyId, agent, BigInt(amount));
      const receipt = await tx.wait();
      txHash = receipt.hash;
    } catch (err) {
      // The chain is the final source of truth — if it reverts, we reject
      // even if our local ledger thought there was room.
      return res.status(402).json({ approved: false, reason: "on-chain deduction reverted", detail: err.message });
    }
  }

  // Update local ledger (mirrors the contract's state so /policy/:id can
  // read fast without hitting the chain on every request).
  db.prepare("UPDATE agent_budgets SET spent = spent + ? WHERE policy_id = ? AND agent = ?").run(amount, policyId, agent);
  db.prepare("UPDATE policies SET spent = spent + ? WHERE id = ?").run(amount, policyId);

  const updatedPolicy = db.prepare("SELECT * FROM policies WHERE id = ?").get(policyId);
  const updatedBudget = db.prepare("SELECT * FROM agent_budgets WHERE policy_id = ? AND agent = ?").get(policyId, agent);

  remainingGlobal = updatedPolicy.global_budget - updatedPolicy.spent;
  remainingAgent = updatedBudget.soft_cap - updatedBudget.spent;

  db.prepare(`
    INSERT INTO events (policy_id, agent, type, amount, remaining_global, remaining_agent, tx_hash)
    VALUES (?, ?, 'BudgetDeducted', ?, ?, ?, ?)
  `).run(policyId, agent, amount, remainingGlobal, remainingAgent, txHash);

  res.json({
    approved: true,
    policyId,
    agent,
    amount,
    remainingGlobal,
    remainingAgent,
    txHash,
    mode: LIVE ? "live" : "simulated",
  });
});

module.exports = router;
