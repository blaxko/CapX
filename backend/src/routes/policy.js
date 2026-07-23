const express = require("express");
const db = require("../lib/db");
const { LIVE, contract } = require("../lib/chain");

const router = express.Router();

// POST /policy
// body: { orchestrator, globalBudget, agents: [{ wallet, softCap }] }
router.post("/policy", async (req, res) => {
  const { orchestrator, globalBudget, agents } = req.body || {};

  if (!orchestrator || typeof globalBudget !== "number" || globalBudget <= 0) {
    return res.status(400).json({ error: "orchestrator and a positive numeric globalBudget are required" });
  }
  if (!Array.isArray(agents) || agents.length === 0) {
    return res.status(400).json({ error: "agents must be a non-empty array of { wallet, softCap }" });
  }
  for (const a of agents) {
    if (!a.wallet || typeof a.softCap !== "number" || a.softCap <= 0) {
      return res.status(400).json({ error: "each agent needs a wallet and a positive numeric softCap" });
    }
  }

  let chainPolicyId = null;
  let txHash = null;
  let contractAddress = process.env.CONTRACT_ADDRESS || null;

  if (LIVE) {
    try {
      const tx = await contract.createPolicy(
        BigInt(globalBudget),
        agents.map((a) => a.wallet),
        agents.map((a) => BigInt(a.softCap))
      );
      const receipt = await tx.wait();
      txHash = receipt.hash;
      // PolicyCreated is emitted with an incrementing id; for a clean MVP we
      // read nextPolicyId - 1 rather than parsing logs here.
    } catch (err) {
      return res.status(502).json({ error: "on-chain createPolicy failed", detail: err.message });
    }
  }

  const insertPolicy = db.prepare(`
    INSERT INTO policies (orchestrator, global_budget, chain_policy_id, tx_hash, contract_address)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = insertPolicy.run(orchestrator, globalBudget, chainPolicyId, txHash, contractAddress);
  const policyId = result.lastInsertRowid;

  const insertAgent = db.prepare(`
    INSERT INTO agent_budgets (policy_id, agent, soft_cap) VALUES (?, ?, ?)
  `);
  for (const a of agents) {
    insertAgent.run(policyId, a.wallet, a.softCap);
  }

  db.prepare(`
    INSERT INTO events (policy_id, type, amount, reason) VALUES (?, 'PolicyCreated', ?, ?)
  `).run(policyId, globalBudget, LIVE ? "on-chain" : "simulated");

  res.status(201).json({
    policyId,
    contractAddress,
    txHash,
    mode: LIVE ? "live" : "simulated",
  });
});

// GET /policy/:id
router.get("/policy/:id", (req, res) => {
  const policyId = Number(req.params.id);
  const policy = db.prepare("SELECT * FROM policies WHERE id = ?").get(policyId);
  if (!policy) return res.status(404).json({ error: "policy not found" });

  const agentRows = db.prepare("SELECT * FROM agent_budgets WHERE policy_id = ?").all(policyId);
  const events = db.prepare("SELECT * FROM events WHERE policy_id = ? ORDER BY id DESC LIMIT 50").all(policyId);

  res.json({
    policyId: policy.id,
    orchestrator: policy.orchestrator,
    globalBudget: policy.global_budget,
    spent: policy.spent,
    remaining: policy.global_budget - policy.spent,
    paused: Boolean(policy.paused),
    contractAddress: policy.contract_address,
    txHash: policy.tx_hash,
    agents: agentRows.map((a) => ({
      wallet: a.agent,
      softCap: a.soft_cap,
      spent: a.spent,
      remaining: a.soft_cap - a.spent,
      active: Boolean(a.active),
    })),
    recentEvents: events,
  });
});

// POST /policy/:id/pause
router.post("/policy/:id/pause", async (req, res) => {
  const policyId = Number(req.params.id);
  const policy = db.prepare("SELECT * FROM policies WHERE id = ?").get(policyId);
  if (!policy) return res.status(404).json({ error: "policy not found" });

  if (LIVE) {
    try {
      await (await contract.emergencyPause(policyId)).wait();
    } catch (err) {
      return res.status(502).json({ error: "on-chain emergencyPause failed", detail: err.message });
    }
  }

  db.prepare("UPDATE policies SET paused = 1 WHERE id = ?").run(policyId);
  db.prepare("INSERT INTO events (policy_id, type) VALUES (?, 'EmergencyPaused')").run(policyId);
  res.json({ policyId, paused: true });
});

// POST /policy/:id/resume
router.post("/policy/:id/resume", async (req, res) => {
  const policyId = Number(req.params.id);
  const policy = db.prepare("SELECT * FROM policies WHERE id = ?").get(policyId);
  if (!policy) return res.status(404).json({ error: "policy not found" });

  if (LIVE) {
    try {
      await (await contract.resumePolicy(policyId)).wait();
    } catch (err) {
      return res.status(502).json({ error: "on-chain resumePolicy failed", detail: err.message });
    }
  }

  db.prepare("UPDATE policies SET paused = 0 WHERE id = ?").run(policyId);
  db.prepare("INSERT INTO events (policy_id, type) VALUES (?, 'PolicyResumed')").run(policyId);
  res.json({ policyId, paused: false });
});

// POST /policy/:id/topup
router.post("/policy/:id/topup", async (req, res) => {
  const policyId = Number(req.params.id);
  const { amount } = req.body || {};
  const policy = db.prepare("SELECT * FROM policies WHERE id = ?").get(policyId);
  if (!policy) return res.status(404).json({ error: "policy not found" });
  if (typeof amount !== "number" || amount <= 0) {
    return res.status(400).json({ error: "amount must be a positive number" });
  }

  if (LIVE) {
    try {
      await (await contract.topUpBudget(policyId, BigInt(amount))).wait();
    } catch (err) {
      return res.status(502).json({ error: "on-chain topUpBudget failed", detail: err.message });
    }
  }

  db.prepare("UPDATE policies SET global_budget = global_budget + ? WHERE id = ?").run(amount, policyId);
  db.prepare("INSERT INTO events (policy_id, type, amount) VALUES (?, 'BudgetTopUp', ?)").run(policyId, amount);
  const updated = db.prepare("SELECT * FROM policies WHERE id = ?").get(policyId);
  res.json({ policyId, globalBudget: updated.global_budget });
});

module.exports = router;
