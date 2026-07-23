const { ethers } = require("ethers");
require("dotenv").config();

const ABI = [
  "function createPolicy(uint256 globalBudget, address[] agents, uint256[] softCaps) returns (uint256)",
  "function registerAgent(uint256 policyId, address agent, uint256 softCap)",
  "function checkAndDeduct(uint256 policyId, address agent, uint256 amount) returns (uint256 remainingGlobal, uint256 remainingAgent)",
  "function emergencyPause(uint256 policyId)",
  "function resumePolicy(uint256 policyId)",
  "function topUpBudget(uint256 policyId, uint256 additionalAmount)",
  "function remainingBudget(uint256 policyId) view returns (uint256)",
  "function remainingAgentBudget(uint256 policyId, address agent) view returns (uint256)",
  "event PolicyCreated(uint256 indexed policyId, address indexed orchestrator, uint256 globalBudget)",
  "event BudgetDeducted(uint256 indexed policyId, address indexed agent, uint256 amount, uint256 remainingGlobal, uint256 remainingAgent)",
  "event BudgetExceeded(uint256 indexed policyId, address indexed agent, uint256 attemptedAmount, string reason)",
];

const LIVE = Boolean(process.env.CONTRACT_ADDRESS && process.env.XLAYER_RPC && process.env.DEPLOYER_PRIVATE_KEY);

let provider, wallet, contract;

if (LIVE) {
  provider = new ethers.JsonRpcProvider(process.env.XLAYER_RPC);
  wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, wallet);
  console.log("[chain] LIVE mode — talking to CapX at", process.env.CONTRACT_ADDRESS, "on", process.env.XLAYER_RPC);
} else {
  console.log("[chain] SIMULATION mode — no CONTRACT_ADDRESS/XLAYER_RPC/DEPLOYER_PRIVATE_KEY set.");
  console.log("[chain] Backend logic runs identically to the deployed contract, but nothing is broadcast on-chain.");
  console.log("[chain] Set those three env vars once CapX.sol is deployed to X Layer to go live.");
}

module.exports = { LIVE, provider, wallet, contract };
