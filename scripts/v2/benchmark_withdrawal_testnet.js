require("dotenv").config();
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { ethers, artifacts } = require("hardhat");
const { buildPoseidon } = require("circomlibjs");
const { PersistentProtocolState } = require("../../lib/v2/persistent-state");
const { authorizeRootBudgetRelease } = require("../../lib/v2/escrow-withdrawal");
const { PROTOCOL_VERSION, ROOT_CAPABILITY_TYPES, eip712Domain, rootCapabilityTypedValue,
  computeRootCapabilityCommitment } = require("../../lib/protocol-v2");
async function main() {
  assert.strictEqual(process.env.ALLOW_TESTNET_BENCHMARK, "1");
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const dir = path.resolve(__dirname, "../../experiments/v2/results", config.campaignId);
  const dep = JSON.parse(fs.readFileSync(path.join(dir, "deployment_manifest.json"), "utf8"));
  assert(dep.completedAt);
  const rpc = new ethers.providers.StaticJsonRpcProvider(process.env.SEPOLIA_RPC_URL,
    { chainId: config.settlementChain.chainId, name: "sepolia" });
  const payer = new ethers.Wallet(process.env.TRUSTED_ISSUER_PRIVATE_KEY, rpc);
  const authority = new ethers.Wallet(process.env.GATEWAY_RELEASE_PRIVATE_KEY, rpc);
  const buyer = new ethers.Wallet(process.env.BUYER_PRIVATE_KEY).address;
  const artifact = await artifacts.readArtifact("EscrowReceiptV2");
  const escrow = new ethers.Contract(dep.predicted.escrow, artifact.abi, payer);
  const poseidon = await buildPoseidon();
  const evidence = path.join(dir, "withdrawal_public_testnet.jsonl");
  assert(!fs.existsSync(evidence), "preserve previous public withdrawal run");
  const depth = config.settlementChain.finalityConfirmations;
  const record = x => fs.appendFileSync(evidence, JSON.stringify({time:new Date().toISOString(), ...x})+"\n");
  const wait = async (op, tx) => {
    record({operation:op,phase:"submitted",transactionHash:tx.hash});
    const started = performance.now(); const r = await tx.wait(depth);
    assert.strictEqual(r.status,1);
    record({operation:op,phase:"confirmed",transactionHash:tx.hash,gasUsed:r.gasUsed.toNumber(),
      blockNumber:r.blockNumber,confirmations:depth,finalityMs:performance.now()-started});
  };
  const initialE = await escrow.escrowBalance(payer.address);
  const initialL = await escrow.protectedBudget(payer.address);
  assert(initialE.gte(initialL), "existing roots must be fully covered");
  const latest = await rpc.getBlock("latest");
  const root = {protocolVersion:PROTOCOL_VERSION, issuer:payer.address,payer:payer.address,buyer,
    taskId:ethers.utils.id(config.campaignId+":withdrawal"),permissions:7,budget:100,
    expiry:latest.timestamp+180,maxSubcalls:1,nonce:20261015,
    scopeHash:ethers.utils.id("withdrawal-empty-root"),settlementDomainHash:dep.settlementDomainHash,
    capabilityCommitment:0};
  root.capabilityCommitment=computeRootCapabilityCommitment(poseidon,root).toString();
  const sig=await payer._signTypedData(eip712Domain(config.settlementChain.chainId,escrow.address),
    ROOT_CAPABILITY_TYPES,rootCapabilityTypedValue(root));
  const state=new PersistentProtocolState(path.join(dir,"withdrawal_gateway.sqlite"));
  try {
    state.registerRoot({rootCommitment:root.capabilityCommitment,payer:root.payer,buyer:root.buyer,
      budget:root.budget,maxSubcalls:root.maxSubcalls,expiry:root.expiry,metadata:{root}});
    record({operation:"setup",root,initialEscrow:initialE.toString(),initialProtected:initialL.toString(),
      scenario:"expired unused root without admitted calls; surplus withdrawal and reconciled release"});
    await wait("register_root",await escrow.registerRootCapability(root,sig));
    await wait("deposit",await escrow.depositFor(payer.address,{value:120}));
    await wait("surplus_withdrawal",await escrow.withdraw(20,buyer));
    assert((await escrow.escrowBalance(payer.address)).eq(initialE.add(100)));
    assert((await escrow.protectedBudget(payer.address)).eq(initialL.add(100)));
    const deadline=Date.now()+600000;
    for (;;) {
      const head=await rpc.getBlockNumber();const finalized=await rpc.getBlock(head-depth+1);
      if(finalized.timestamp>=root.expiry)break;
      assert(Date.now()<deadline,"finalized expiry wait timed out");
      await new Promise(r=>setTimeout(r,12000));
    }
    const auth=await authorizeRootBudgetRelease({state,escrow,signer:authority,
      rootCommitment:root.capabilityCommitment,confirmations:depth});
    record({operation:"reconciliation",statement:auth.statement,snapshot:auth.snapshot});
    const a=auth.statement;
    await wait("root_budget_release",await escrow.releaseUnusedRootBudget(a.rootCommitment,
      a.settledAmount,a.settledCalls,a.validUntil,auth.signature));
    await wait("released_budget_withdrawal",await escrow.withdraw(100,buyer));
    assert((await escrow.escrowBalance(payer.address)).eq(initialE));
    assert((await escrow.protectedBudget(payer.address)).eq(initialL));
    assert(await escrow.rootFundsReleased(root.capabilityCommitment));
    record({operation:"verified",scope:"one unused-root scenario, not a performance distribution",
      escrowRestored:true,protectedBudgetRestored:true,rootReleased:true});
    console.log("PASS public-testnet surplus withdrawal, finalized reconciliation and unused-budget withdrawal");
  } finally {state.close();}
}
main().catch(e=>{console.error(e.name,e.reason||e.message);process.exitCode=1;});
