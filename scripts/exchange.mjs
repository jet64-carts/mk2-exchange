#!/usr/bin/env node
// mk2-exchange/scripts/exchange.mjs
//
// A client of the exchange in one file, with nothing to install: what the
// island's EXPORT and EXCHANGE will do in C (docs/exchange.md §5, §7), and
// David's sysop switches until EXCHANGE shows them.
//
//   node scripts/exchange.mjs key <file>                      make a key; print its public half
//   node scripts/exchange.mjs public <file>                   print a key's public half
//   node scripts/exchange.mjs publish <file> <maker> <disk>   send a disk file
//   node scripts/exchange.mjs state <id>                      where an upload stands
//   node scripts/exchange.mjs index                           the catalogue
//   node scripts/exchange.mjs report <file> <id>              report a disk
//   node scripts/exchange.mjs remove <file> <id>              take down your own cart, every version
//   node scripts/exchange.mjs label <id> <out> [file]         save a disk's label; signed by the
//                                                             sysop's key, a hidden disk's too
//   node scripts/exchange.mjs sysop <file> <action> [id|maker] [new key|cart]
//       pause, resume, remove <id> (the whole cart; yank is its older name),
//       hide <id>, keep <id> (a hidden disk was fine; unhide is its older name),
//       ban <maker>, unban <maker>, vouch <maker>, unvouch <maker>,
//       revoke <maker>, rekey <maker> <key>, hidden,
//       zero <maker> <cart> (the cart's takes begin again at 0)
//
// EXCHANGE names the exchange; https://exchange.jet64.com when unset.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const EXCHANGE = process.env.EXCHANGE ?? "https://exchange.jet64.com";
const SIGNED_FORM = "jet64-exchange-1";

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function makeKey(path) {
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  return publicOf(path);
}

function loadKey(path) {
  return createPrivateKey(readFileSync(path));
}

function publicOf(path) {
  const spki = createPublicKey(loadKey(path)).export({ type: "spki", format: "der" });
  return base64url(spki.subarray(spki.length - 32));
}

// A request signed with the key at `keyPath`. One with no body, a GET among
// them, is signed with the empty body's hash.
async function signedRequest(keyPath, method, path, body, bodyHash = sha256(body ?? Buffer.alloc(0))) {
  const time = String(Math.floor(Date.now() / 1000));
  const message = [SIGNED_FORM, method, path, time, bodyHash].join("\n");
  const signature = sign(null, Buffer.from(message), loadKey(keyPath));
  return fetch(EXCHANGE + path, {
    method,
    body,
    headers: {
      "x-jet-key": publicOf(keyPath),
      "x-jet-time": time,
      "x-jet-sha256": bodyHash,
      "x-jet-signature": base64url(signature),
      ...(body ? { "content-length": String(body.length) } : {}),
    },
    duplex: "half",
  });
}

async function signed(...asked) {
  return say(await signedRequest(...asked));
}

async function say(response) {
  const text = await response.text();
  console.log(text);
  if (!response.ok) process.exitCode = 1;
  return text;
}

// A disk's label saved to `out`, or the refusal said.
async function saveLabel(id, out, keyPath) {
  const path = `/label/${id}`;
  const response = keyPath ? await signedRequest(keyPath, "GET", path) : await fetch(EXCHANGE + path);
  if (!response.ok) return say(response);
  writeFileSync(out, Buffer.from(await response.arrayBuffer()));
  console.log(`saved ${out}, cache-control: ${response.headers.get("cache-control")}`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "key": console.log(makeKey(rest[0])); break;
  case "public": console.log(publicOf(rest[0])); break;
  case "publish": {
    const [keyPath, maker, disk] = rest;
    const bytes = readFileSync(disk);
    await signed(keyPath, "POST", `/disks?maker=${encodeURIComponent(maker)}`, bytes, sha256(bytes));
    break;
  }
  case "state": await say(await fetch(`${EXCHANGE}/disks/${rest[0]}`)); break;
  case "index": await say(await fetch(`${EXCHANGE}/index`)); break;
  case "report": await signed(rest[0], "POST", `/report/${rest[1]}`); break;
  case "remove": await signed(rest[0], "POST", `/remove/${rest[1]}`); break;
  case "label": await saveLabel(rest[0], rest[1], rest[2]); break;
  case "sysop": {
    const [keyPath, action, target, second] = rest;
    const asked = { action };
    if (["remove", "yank", "hide", "keep", "unhide"].includes(action)) asked.id = target;
    if (["ban", "unban", "vouch", "unvouch", "revoke", "rekey", "zero"].includes(action)) asked.maker = target;
    if (action === "rekey") asked.key = second;
    if (action === "zero") asked.name = second;
    const body = Buffer.from(JSON.stringify(asked));
    await signed(keyPath, "POST", "/sysop", body);
    break;
  }
  default:
    console.error("usage: node scripts/exchange.mjs key|public|publish|state|index|report|remove|label|sysop ...");
    process.exitCode = 2;
}
