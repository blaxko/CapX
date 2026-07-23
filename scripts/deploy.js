const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying CapX with account:", deployer.address);

  const CapX = await hre.ethers.getContractFactory("CapX");
  const capx = await CapX.deploy();
  await capx.waitForDeployment();

  const address = await capx.getAddress();
  console.log("CapX deployed to:", address);
  console.log("Network:", hre.network.name);
  console.log("");
  console.log("Set this in backend/.env as CONTRACT_ADDRESS=" + address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
