import { ethers } from "ethers";
import axios from "axios";
import fs from "fs/promises";
import { HttpsProxyAgent } from "https-proxy-agent";
import readline from "readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

const c = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", b: "\x1b[36m", x: "\x1b[90m", z: "\x1b[0m" };

const RPC_URL = "https://api.zan.top/node/v1/pharos/atlantic/be53891571bc44dc9e1acffd0155bbd7";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const TOKEN = "0x4f848D61B35033619Ce558a2FCe8447Cedd38D0d";
const FAUCET = "0x69ea30AB859ff2a51e41a85426e4C0Ea10c2D9f5";
const STRUCTURE = "0x62fdbc600e8badf8127e6298dd12b961edf08b5f";

const STRUCTURE_CALL = "0xef2720208b79ddf5ff2f0db54884b06a0b748a687abe7eb723e676eac22a5a811e9312ae0000000000000000000000000000000000000000000000000de0b6b3a7640000";
const STAKE_CALL = "0xa694fc3a000000000000000000000000000000000000000000000000002386f26fc10000";

const STAKES = [
  { name: "S-MMF",  token: "0xee1fc944a610032da42e7e8c5135f4a532e1dafc", contract: "0x35c0a2d969a79306788b97a6c2af0a22df424de1" },
  { name: "S-CORP", token: "0xed75c5b68284a1a9568e26a2b48655a3d518d4bc", contract: "0x534966536969c3b697a04538e475992c981521cf" },
  { name: "S-UST",  token: "0x93bc7267d802201e51926bef331de80c965ec55f", contract: "0x92864f94020e79a52aca036c6a3d3be9d4388a39" },
  { name: "S-PCT",  token: "0xc1cf3cf3a86807e8319c0ab1754413c854ab5b7d", contract: "0x3eaef8f467059915a6eeb985a0d08de063ab16f9" }
];

const LOGIN_URL = "https://api3.aquaflux.pro/api/v1/users/wallet-login";
const FAUCET_URL = "https://api3.aquaflux.pro/api/v1/faucet/claim-signature";
const ABI = ["function approve(address,uint256) external returns (bool)"];
const STATE = "last-run.json";
const PROXY_FILE = "proxy.txt";

let proxies = [], pIdx = 0;

async function loadProxies() {
  try {
    proxies = (await fs.readFile(PROXY_FILE, "utf-8")).split("\n").map(l => l.trim()).filter(Boolean);
    console.log(`${c.b}Loaded ${proxies.length} proxy(ies)${c.z}`);
  } catch { console.log(`${c.y}No proxy.txt → using direct connection${c.z}`); }
}

function getAgent() {
  if (!proxies.length) return undefined;
  const p = proxies[pIdx % proxies.length]; pIdx++;
  return new HttpsProxyAgent(`http://${p}`);
}

async function delay(ms) { await new Promise(r => setTimeout(r, ms)); }

function encodeFaucet(a, d, s) {
  let sig = s.replace(/^0x/, "").padEnd(192, "0");
  return "0xc564e9ce" + ethers.zeroPadValue(TOKEN,32).slice(2) +
    ethers.zeroPadValue(ethers.toBeHex(a),32).slice(2) +
    ethers.zeroPadValue(ethers.toBeHex(d),32).slice(2) +
    "0000000000000000000000000000000000000000000000000000000000000080" +
    "0000000000000000000000000000000000000000000000000000000000000041" + sig;
}

async function doFaucet(wallet, http) {
  try {
    const msg = `Sign in to AquaFlux Faucet with timestamp: ${Date.now()}`;
    const sig = await wallet.signMessage(msg);
    const login = await http.post(LOGIN_URL, { address: wallet.address, message: msg, signature: sig }, { headers: { "content-type": "application/json" }});
    if (login.data.status !== "success") return false;
    const token = login.data.data.accessToken;
    const res = await http.post(FAUCET_URL, { tokenAddress: TOKEN }, { headers: { Authorization: `Bearer ${token}` }});
    if (!res.data.success) return false;
    const tx = await wallet.sendTransaction({ to: FAUCET, data: encodeFaucet(res.data.data.baseAmount, res.data.data.expiresAt, res.data.data.signature), gasLimit: 600000 });
    await tx.wait();
    console.log(`${c.g}Faucet claimed${c.z}`);
    return true;
  } catch { console.log(`${c.y}Faucet skipped (already claimed or error)${c.z}`); return false; }
}

async function doStructure(wallet) {
  try {
    const t = new ethers.Contract(TOKEN, ABI, wallet);
    await (await t.approve(STRUCTURE, ethers.parseUnits("1000000",18))).wait();
  } catch {}
  for (let i = 0; i < 50; i++) {
    try { await (await wallet.sendTransaction({ to: STRUCTURE, data: STRUCTURE_CALL })).wait(); } catch {}
    if ((i+1)%10===0) console.log(`${c.x}Structure ${i+1}/50${c.z}`);
    await delay(700);
  }
}

async function doStake(wallet) {
  for (const s of STAKES) {
    try {
      const t = new ethers.Contract(s.token, ABI, wallet);
      await (await t.approve(s.contract, ethers.parseUnits("1000000",18))).wait();
      console.log(`${c.g}Approved ${s.name}${c.z}`);
    } catch {}
    for (let i = 0; i < 50; i++) {
      try { await (await wallet.sendTransaction({ to: s.contract, data: STAKE_CALL })).wait(); } catch {}
      if ((i+1)%10===0) console.log(`${c.x}${s.name} Stake ${i+1}/50${c.z}`);
      await delay(700);
    }
  }
}

async function processWallet(key, addr, mode) {
  const wallet = new ethers.Wallet(key.startsWith("0x")?key:"0x"+key, provider);
  console.log(`\n${c.b}[${addr}] Starting → Mode ${mode}${c.z}`);

  const http = axios.create({ httpsAgent: getAgent(), httpAgent: getAgent(), timeout: 30000 });

  if (mode === 1 || mode === 4) await doFaucet(wallet, http);
  if (mode === 2 || mode === 4) await doStructure(wallet);
  if (mode === 3 || mode === 4) await doStake(wallet);

  console.log(`${c.b}${addr} → Completed${c.z}\n`);
  return true;
}

async function main() {
  console.clear();
  console.log(`${c.b}
  ╔══════════════════════════════════════╗
  ║        AQUAFLUX ATLANTIC             ║
  ╚══════════════════════════════════════╝${c.z}\n`);

  await loadProxies();

  console.log(`${c.y}Choose your farming mode:${c.z}`);
  console.log(`   ${c.g}1${c.z} → Faucet Claim Only`);
  console.log(`   ${c.g}2${c.z} → Structure 50× Only`);
  console.log(`   ${c.g}3${c.z} → Stake All 4 Tokens (200×) Only`);
  console.log(`   ${c.g}4${c.z} → ALL FEATURES (Recommended)\n`);

  const choice = await ask(`${c.b}Enter option (1-4): ${c.z}`);
  const mode = [1,2,3,4].includes(+choice) ? +choice : 4;
  rl.close();

  console.log(`\n${c.b}Mode ${mode} selected: ${mode===1?"Faucet":mode===2?"Structure":mode===3?"Stake Only":"ALL FEATURES"}${c.z}\n`);

  const keys = (await fs.readFile("accounts.txt","utf-8")).split("\n").map(l=>l.trim()).filter(Boolean);
  const state = await (async()=>{try{return JSON.parse(await fs.readFile(STATE,"utf-8"));}catch{return{}}})();
  const now = Date.now(), day = 86400000;

  let todo = [];
  for (const k of keys) {
    const a = new ethers.Wallet(k.startsWith("0x")?k:"0x"+k).address.toLowerCase();
    if (!state[a] || now-state[a] >= day) todo.push({k, a});
    else console.log(`${c.x}[${a}] Already done today${c.z}`);
  }

  if (todo.length === 0 && mode === 4) {
    const wait = Math.ceil((day - (now - Math.max(...Object.values(state))))/1000);
    console.log(`\n${c.y}All wallets done today → Next cycle in ${wait}s${c.z}`);
    for (let i = wait; i >= 0; i--) {
      process.stdout.write(`\r${c.b}Waiting ${i}s to restart...${c.z}   `);
      await delay(1000);
    }
    await fs.unlink(STATE).catch(()=>{});
    return main();
  }

  for (const w of todo) {
    console.log(`${c.b}=== Processing ${w.a} ===${c.z}`);
    if (await processWallet(w.k, w.a, mode)) state[w.a] = now;
    await fs.writeFile(STATE, JSON.stringify(state,null,2));
    await delay(5000);
  }

  console.log(`${c.g}\nFinished ${todo.length} wallet(s) → Mode ${mode}${c.z}`);
  console.log(`${c.b}You can close the terminal. Run again tomorrow!${c.z}`);
}


main();
