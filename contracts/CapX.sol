// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title CapX — On-chain spend enforcement for autonomous AI agent fleets
/// @notice An orchestrator agent creates a Policy with a global budget and
///         per-agent soft caps. Every payment a sub-agent wants to make must
///         clear checkAndDeduct() first. The deduction is atomic: it either
///         succeeds and the ledger updates, or it reverts entirely. There is
///         no code path where a sub-agent's spend is "provisionally" allowed
///         and cleaned up later — the cap is enforced by the EVM, not by
///         whichever application happens to be calling this contract.
/// @dev Deployed on X Layer (Chain ID 196). Gas paid in OKB.
///
/// Storage note: external functions still take `uint256` amounts for a
/// simple, stable ABI — but internally, budgets and spend are downcast to
/// `uint128` via SafeCast (reverting cleanly if a caller ever passes
/// something absurd like >2^128 wei) and packed into shared storage slots.
/// Policy fits in 2 slots instead of 4; AgentBudget fits in 1 instead of 3.
/// This roughly halves the SSTORE cost of every checkAndDeduct() call,
/// which matters because it's the one function called on every single
/// agent-to-agent payment.
contract CapX is AccessControl, ReentrancyGuard {
    using SafeCast for uint256;

    bytes32 public constant ORCHESTRATOR_ROLE = keccak256("ORCHESTRATOR_ROLE");

    error PolicyNotFound();
    error PolicyPaused();
    error UnauthorizedOrchestrator();
    error AgentNotActive();
    error AgentIsZeroAddress();
    error ArrayLengthMismatch();
    error GlobalBudgetMustBePositive();
    error TopUpMustBePositive();
    error GlobalBudgetExceeded(uint256 requested, uint256 remaining);
    error AgentSoftCapExceeded(uint256 requested, uint256 remaining);

    struct Policy {
        address orchestrator; // slot 1: 20 bytes
        bool paused;          // slot 1: packs with orchestrator
        bool exists;          // slot 1: packs with orchestrator
        uint128 globalBudget; // slot 2
        uint128 spent;        // slot 2: packs with globalBudget
    }

    struct AgentBudget {
        uint128 softCap; // slot 1
        uint128 spent;   // slot 1: packs with softCap
        bool active;     // slot 2
    }

    uint256 public nextPolicyId;

    mapping(uint256 => Policy) public policies;
    // policyId => agent address => budget
    mapping(uint256 => mapping(address => AgentBudget)) public agentBudgets;

    event PolicyCreated(uint256 indexed policyId, address indexed orchestrator, uint256 globalBudget);
    event AgentRegistered(uint256 indexed policyId, address indexed agent, uint256 softCap);
    event BudgetDeducted(uint256 indexed policyId, address indexed agent, uint256 amount, uint256 remainingGlobal, uint256 remainingAgent);
    event BudgetExceeded(uint256 indexed policyId, address indexed agent, uint256 attemptedAmount, string reason);
    event BudgetTopUp(uint256 indexed policyId, uint256 addedAmount, uint256 newGlobalBudget);
    event EmergencyPaused(uint256 indexed policyId, address indexed by);
    event PolicyResumed(uint256 indexed policyId, address indexed by);

    modifier onlyPolicyOrchestrator(uint256 policyId) {
        if (!policies[policyId].exists) revert PolicyNotFound();
        if (policies[policyId].orchestrator != msg.sender) revert UnauthorizedOrchestrator();
        _;
    }

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @notice Create a new fleet spending policy.
    /// @param globalBudget Total budget available across all agents in this fleet, in wei.
    /// @param agents Initial list of sub-agent wallet addresses to register.
    /// @param softCaps Per-agent spend caps, in wei, matching the `agents` array by index.
    function createPolicy(
        uint256 globalBudget,
        address[] calldata agents,
        uint256[] calldata softCaps
    ) external returns (uint256 policyId) {
        if (globalBudget == 0) revert GlobalBudgetMustBePositive();
        if (agents.length != softCaps.length) revert ArrayLengthMismatch();

        policyId = nextPolicyId++;

        policies[policyId] = Policy({
            orchestrator: msg.sender,
            paused: false,
            exists: true,
            globalBudget: globalBudget.toUint128(),
            spent: 0
        });

        _grantRole(ORCHESTRATOR_ROLE, msg.sender);

        for (uint256 i = 0; i < agents.length; i++) {
            _registerAgent(policyId, agents[i], softCaps[i]);
        }

        emit PolicyCreated(policyId, msg.sender, globalBudget);
    }

    /// @notice Register an additional agent under an existing policy.
    function registerAgent(uint256 policyId, address agent, uint256 softCap)
        external
        onlyPolicyOrchestrator(policyId)
    {
        _registerAgent(policyId, agent, softCap);
    }

    function _registerAgent(uint256 policyId, address agent, uint256 softCap) internal {
        if (agent == address(0)) revert AgentIsZeroAddress();
        agentBudgets[policyId][agent] = AgentBudget({
            softCap: softCap.toUint128(),
            spent: 0,
            active: true
        });
        emit AgentRegistered(policyId, agent, softCap);
    }

    /// @notice Atomically check and deduct a spend against both the agent's
    ///         soft cap and the fleet's global hard cap. Reverts entirely on
    ///         failure — there is no partial execution.
    /// @param policyId The policy this spend belongs to.
    /// @param agent The sub-agent attempting to spend.
    /// @param amount The amount, in wei, the agent wants to spend.
    function checkAndDeduct(uint256 policyId, address agent, uint256 amount)
        external
        nonReentrant
        returns (uint256 remainingGlobal, uint256 remainingAgent)
    {
        Policy storage policy = policies[policyId];
        if (!policy.exists) revert PolicyNotFound();
        if (policy.paused) revert PolicyPaused();

        AgentBudget storage budget = agentBudgets[policyId][agent];
        if (!budget.active) revert AgentNotActive();

        uint128 amount128 = amount.toUint128();

        if (budget.spent + amount128 > budget.softCap) {
            emit BudgetExceeded(policyId, agent, amount, "agent soft cap exceeded");
            revert AgentSoftCapExceeded(amount, budget.softCap - budget.spent);
        }
        if (policy.spent + amount128 > policy.globalBudget) {
            emit BudgetExceeded(policyId, agent, amount, "global hard cap exceeded");
            revert GlobalBudgetExceeded(amount, policy.globalBudget - policy.spent);
        }

        budget.spent += amount128;
        policy.spent += amount128;

        remainingGlobal = policy.globalBudget - policy.spent;
        remainingAgent = budget.softCap - budget.spent;

        emit BudgetDeducted(policyId, agent, amount, remainingGlobal, remainingAgent);
    }

    /// @notice Instantly freeze all spending under a policy. Single transaction,
    ///         no per-agent calls required.
    function emergencyPause(uint256 policyId) external onlyPolicyOrchestrator(policyId) {
        policies[policyId].paused = true;
        emit EmergencyPaused(policyId, msg.sender);
    }

    /// @notice Resume a paused policy.
    function resumePolicy(uint256 policyId) external onlyPolicyOrchestrator(policyId) {
        policies[policyId].paused = false;
        emit PolicyResumed(policyId, msg.sender);
    }

    /// @notice Increase a policy's global budget mid-job.
    function topUpBudget(uint256 policyId, uint256 additionalAmount)
        external
        onlyPolicyOrchestrator(policyId)
    {
        if (additionalAmount == 0) revert TopUpMustBePositive();
        Policy storage policy = policies[policyId];
        policy.globalBudget += additionalAmount.toUint128();
        emit BudgetTopUp(policyId, additionalAmount, policy.globalBudget);
    }

    /// @notice Remaining budget across the entire fleet for a policy.
    function remainingBudget(uint256 policyId) external view returns (uint256) {
        Policy storage policy = policies[policyId];
        if (!policy.exists) revert PolicyNotFound();
        return policy.globalBudget - policy.spent;
    }

    /// @notice Remaining budget for a single agent under a policy.
    function remainingAgentBudget(uint256 policyId, address agent) external view returns (uint256) {
        AgentBudget storage budget = agentBudgets[policyId][agent];
        if (!budget.active) revert AgentNotActive();
        return budget.softCap - budget.spent;
    }
}
