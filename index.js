import { ethers } from "ethers";
import axios from "axios";
import fs from "fs/promises";                    
import { HttpsProxyAgent } from "https-proxy-agent";
import readline from "readline/promises";

// Colors
const c = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  reset: "\x1b[0m"
};

const RPC_URL = "https://api.zan.top/node/v1/pharos/atlantic/be53891571bc44dc9e1acffd0155bbd7";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const FAUCET_CONTRACT = "0x69ea30AB859ff2a51e41a85426e4C0Ea10c2D9f5";
const STRUCTURE_CONTRACT = "0x62fdbc600e8badf8127e6298dd12b961edf08b5f";
const NEW_STAKE_CONTRACT = "0x92864f94020e79a52aca036c6a3d3be9d4388a39";

const PCT_TOKEN = "0x4f848D61B35033619Ce558a2FCe8447Cedd38D0d";
const UST_TOKEN = "0x5e789bb07b2225132d26bb0ffaca7e37a5ecbebb";
const S_PCT_TOKEN = "0xc1cf3cf3a86807e8319c0ab1754413c854ab5b7d";

const FAUCET_TOKENS = [
  "0xb691f00682feef63bc73f41c380ff648d73c6a2c",
  "0x5E789Bb07B2225132d26BB0FFaca7e37A5eCbEbB",
  "0x656B4948C470F3420805abCB43F3928820A0f26D",
  PCT_TOKEN
];

const LOGIN_URL = "https://api3.aquaflux.pro/api/v1/users/wallet-login";
const FAUCET_SIG_URL = "https://api3.aquaflux.pro/api/v1/faucet/claim-signature";

const abiApprove = ["function approve(address,uint256) external returns (bool)"];
const abiStake = ["function stake(uint256 amount) external"];

const STATE_FILE = "last-run.json";
const PROXY_FILE = "proxy.txt";

const headers = {
  "accept": "*/*",
  "content-type": "application/json",
  "origin": "https://testnet.aquaflux.pro",
  "referer": "https://testnet.aquaflux.pro/",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
};

let proxyList = [];
let proxyIndex = 0;
let useProxy = true;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function chooseMode() {
  console.log(`\n${c.cyan}=== Connection Mode ===${c.reset}`);
  console.log("1 → Proxy Mode (Auto Rotate on Error)");
  console.log("2 → Direct Connection");
  const ans = await rl.question(`${c.yellow}Choose (1 or 2): ${c.reset}`);
  useProxy = ans.trim() === "1";
  console.log(useProxy ? `${c.green}→ Proxy Mode enabled${c.reset}` : `${c.green}→ Direct Mode${c.reset}`);
}

async function chooseRunOption() {
  console.log(`\n${c.cyan}=== Run Options ===${c.reset}`);
  console.log("1 → Faucet Claim Only");
  console.log("2 → Structure Only (UST - 75 times)");
  console.log("3 → Stake Only (New Contract - 75 times)");
  console.log("4 → Run All Features");
  const ans = await rl.question(`${c.yellow}Choose option (1-4): ${c.reset}`);
  const option = parseInt(ans.trim());
  return [1,2,3,4].includes(option) ? option : 4;
}

async function loadProxies() {
  if (!useProxy) return;
  try {
    const data = await fs.readFile(PROXY_FILE, "utf-8");
    proxyList = data.split("\n").map(l => l.trim()).filter(Boolean);
    console.log(`${c.cyan}Loaded ${proxyList.length} proxies${c.reset}`);
  } catch {
    console.log(`${c.yellow}proxy.txt not found → Direct mode${c.reset}`);
    useProxy = false;
  }
}

function getNextProxyAgent() {
  if (!useProxy || proxyList.length === 0) return undefined;
  const proxyStr = proxyList[proxyIndex % proxyList.length];
  proxyIndex = (proxyIndex + 1) % proxyList.length;
  try {
    return new HttpsProxyAgent(`http://${proxyStr}`);
  } catch { return undefined; }
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function loadState() {
  try { 
    const d = await fs.readFile(STATE_FILE, "utf-8"); 
    return JSON.parse(d); 
  } catch { 
    return {}; 
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function formatTime(seconds) {
  const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}


async function loginWallet(wallet, address) {
  let accessToken = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const agent = getNextProxyAgent();
    const http = axios.create({ httpsAgent: agent, httpAgent: agent, timeout: 30000, proxy: false });

    try {
      const ts = Date.now();
      const message = `Sign in to AquaFlux Faucet with timestamp: ${ts}`;
      const signature = await wallet.signMessage(message);
      const res = await http.post(LOGIN_URL, { address, message, signature }, { headers });

      if (res.data?.status === "success" && res.data.data?.accessToken) {
        console.log(`${c.green}✓ Login successful${c.reset}`);
        return res.data.data.accessToken;
      }
    } catch (err) {
      console.log(`${c.yellow}Login attempt ${attempt} failed${c.reset}`);
      if (attempt < 6) await delay(3000);
    }
  }
  console.log(`${c.red}× Login failed${c.reset}`);
  return null;
}


async function claimFaucets(wallet, address, accessToken) {
  console.log(`${c.cyan}Claiming Faucets...${c.reset}`);
  for (const token of FAUCET_TOKENS) {
    try {
      const sigRes = await axios.post(FAUCET_SIG_URL, { tokenAddress: token }, {
        headers: { ...headers, Authorization: `Bearer ${accessToken}` }
      });

      if (sigRes.data?.success && sigRes.data.data) {
        const { baseAmount, expiresAt, signature: faucetSig } = sigRes.data.data;
        const calldata = ethers.concat([
          "0xc564e9ce",
          ethers.zeroPadValue(token, 32),
          ethers.zeroPadValue(ethers.toBeHex(baseAmount), 32),
          ethers.zeroPadValue(ethers.toBeHex(expiresAt), 32),
          ethers.zeroPadValue("0x80", 32),
          ethers.zeroPadValue("0x41", 32),
          ethers.getBytes(faucetSig)
        ]);

        const tx = await wallet.sendTransaction({ to: FAUCET_CONTRACT, data: calldata, gasLimit: 800000 });
        const receipt = await tx.wait();
        console.log(`${c.green}✓ Faucet Claimed → Explorer: ${c.green}https://atlantic.pharosscan.xyz/tx/${receipt.hash}${c.reset}`);
      }
    } catch {}
    await delay(2000);
  }
}


async function runStructure(wallet) {
  console.log(`${c.cyan}Running Structure with UST - 75 times...${c.reset}`);
  try {
    const ust = new ethers.Contract(UST_TOKEN, abiApprove, wallet);
    await (await ust.approve(STRUCTURE_CONTRACT, ethers.parseUnits("1000000", 18))).wait();
    console.log(`${c.green}✓ UST Approved${c.reset}`);

    const amount = ethers.parseUnits("1", 18);

    for (let i = 0; i < 75; i++) {
      try {
        const fixedPart = "0xef272020d048a586b49e0cf14afc137d0ebec0024a50aa5be56d006ecf46088f47537e33";
        const amountHex = ethers.zeroPadValue(ethers.toBeHex(amount), 32).slice(2);
        const calldata = fixedPart + amountHex;

        const tx = await wallet.sendTransaction({ to: STRUCTURE_CONTRACT, data: calldata, gasLimit: 800000 });
        const receipt = await tx.wait();
        console.log(`${c.green}✓ Structure ${i+1}/75 Success${c.reset} → Explorer: ${c.green}https://atlantic.pharosscan.xyz/tx/${receipt.hash}${c.reset}`);
      } catch (e) {
        if (e.code === "CALL_EXCEPTION" || e.message?.toLowerCase().includes("revert")) {
          console.log(`${c.yellow}Structure reverted → stopping${c.reset}`);
          break;
        }
      }
      await delay(1500);
    }
  } catch (e) {
    console.log(`${c.red}Structure error: ${e.shortMessage || e.message}${c.reset}`);
  }
}


async function runStake(wallet) {
  console.log(`${c.cyan}Running Stake (New Contract) - 75 times...${c.reset}`);
  
  try {
    const ust = new ethers.Contract(UST_TOKEN, abiApprove, wallet);
    await (await ust.approve(NEW_STAKE_CONTRACT, ethers.parseUnits("1000000", 18))).wait();
    console.log(`${c.green}✓ UST Approved for New Stake${c.reset}`);

    const stakeAmountHex = "06f05b59d3b20000";   // 0.5

    for (let i = 0; i < 75; i++) {
      try {
        const calldata = "0xa694fc3a" + stakeAmountHex.padStart(64, "0");

        const tx = await wallet.sendTransaction({
          to: NEW_STAKE_CONTRACT,
          data: calldata,
          gasLimit: 700000
        });

        const receipt = await tx.wait();
        
        console.log(`${c.green}✓ Stake ${i+1}/75 Success${c.reset}`);
        console.log(`${c.cyan}→ Explorer: ${c.green}https://atlantic.pharosscan.xyz/tx/${receipt.hash}${c.reset}`);

      } catch (e) {
        if (e.code === "CALL_EXCEPTION" || e.message?.toLowerCase().includes("revert")) {
          console.log(`${c.yellow}Stake reverted at tx ${i+1} → stopping${c.reset}`);
          break;
        }
        console.log(`${c.red}Stake tx ${i+1} failed${c.reset}`);
      }
      await delay(1500);
    }
  } catch (e) {
    console.log(`${c.red}Staking error: ${e.shortMessage || e.message}${c.reset}`);
  }
}


async function processWallet(privateKey, address, runOption) {
  const pk = privateKey.trim().startsWith("0x") ? privateKey.trim() : `0x${privateKey.trim()}`;
  const wallet = new ethers.Wallet(pk, provider);

  console.log(`\n${c.cyan}[${address.slice(0,8)}...${address.slice(-6)}] Starting (Option ${runOption})...${c.reset}`);

  let accessToken = null;
  if (runOption === 1 || runOption === 4) {
    accessToken = await loginWallet(wallet, address);
    if (!accessToken) return false;
  }

  if (runOption === 1 || runOption === 4) await claimFaucets(wallet, address, accessToken);
  if (runOption === 2 || runOption === 4) await runStructure(wallet);
  if (runOption === 3 || runOption === 4) await runStake(wallet);

  console.log(`${c.green}✓ Wallet completed${c.reset}`);
  return true;
}


async function main() {
  await chooseMode();
  await loadProxies();

  const runOption = await chooseRunOption();

  const data = await fs.readFile("accounts.txt", "utf-8");
  const keys = data.split("\n").map(l => l.trim()).filter(Boolean);

  const state = await loadState();
  const now = Date.now();
  const cooldown = 24 * 60 * 60 * 1000;

  const toProcess = [];

  for (const key of keys) {
    try {
      const w = new ethers.Wallet(key.startsWith("0x") ? key : `0x${key}`);
      const addr = w.address.toLowerCase();
      if (state[addr] && now - state[addr] < cooldown && runOption === 4) {
        const rem = Math.ceil((cooldown - (now - state[addr])) / 1000);
        console.log(`${c.gray}[${addr.slice(0,8)}...] Cooldown → ${formatTime(rem)}${c.reset}`);
      } else {
        toProcess.push({ key, addr });
      }
    } catch (e) {
      console.log(`${c.red}Invalid key skipped${c.reset}`);
    }
  }

  if (toProcess.length === 0) {
    console.log(`${c.yellow}No wallets to process.${c.reset}`);
    rl.close();
    return;
  }

  console.log(`\n${c.cyan}Starting ${toProcess.length} wallet(s) with Option ${runOption}...${c.reset}`);

  for (const { key, addr } of toProcess) {
    const success = await processWallet(key, addr, runOption);
    if (success && runOption === 4) {
      state[addr] = now;
      await saveState(state);
    }
    await delay(10000);
  }

  console.log(`\n${c.green}✅ All done!${c.reset}`);
  rl.close();
}

main().catch(err => {
  console.error(`${c.red}Fatal Error: ${err.message}${c.reset}`);
  rl.close();
});
