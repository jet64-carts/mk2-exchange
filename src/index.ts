// mk2-exchange/src/index.ts
//
// The exchange's only door (docs/exchange.md §4 in the machine's repository).
// It never parses a disk: a disk's bytes stream past it into R2, and only the
// validator, in a GitHub Action with no secrets, opens one. Every limit is
// checked in D1 before R2 is touched, and the Worker stays on the free plan,
// which refuses past its own limits rather than billing.
//
//   GET  /index                  the catalogue, cached
//   GET  /disk/<id>              a live disk's file
//   GET  /label/<id>             a live disk's label
//   GET  /disks/<id>             where an upload stands: checking, live, failed...
//   POST /disks?maker=<name>     publish (signed; the body is the disk file)
//   POST /report/<id>            report a disk (signed)
//   POST /sysop                  David's switches (signed by his key)
//   GET  /quarantine/<id>        a disk being checked, for the validator only
//   POST /verdict/<id>           the validator's verdict (bearer token)

import {
  ADDRESS_UPLOADS_A_DAY, DISK_BYTES_MOST, INDEX_DISKS_MOST, INDEX_SECONDS, KEY_UPLOADS_A_DAY, LABEL_BYTES_MOST,
  NAME_PATTERN, NEW_MAKER_DISK_BYTES_MOST, NEW_MAKER_SECONDS, REPORTS_THAT_HIDE, RESERVED_FOLDS, UPLOAD_BYTES_A_DAY,
  UPLOADS_A_DAY, VERDICT_BYTES_MOST, fold,
} from "./rules";
import { hashAddress, randomId, signedBy } from "./sign";

export interface Env {
  DB: D1Database;
  DISKS: R2Bucket;
  SYSOP_KEY: string;      // David's public key, base64url
  GITHUB_REPO: string;    // where the validator runs: jet64-carts/mk2-exchange
  GITHUB_TOKEN?: string;  // may start the validator's workflow, nothing more (secret)
  VERDICT_TOKEN?: string; // the validator's own, to hand back a verdict (secret)
  IP_SALT?: string;       // so an address is never stored (secret)
}

type Json = Record<string, unknown>;

const KINDS = new Set(["game", "theme", "tool"]);
const INDEX_CACHE_KEY = "https://exchange.internal/index";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error(error);
      return refuse(500, "machine", "the exchange met a fault; please try again later");
    }
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const [head, id] = parts;
  const get = request.method === "GET" || request.method === "HEAD";
  const post = request.method === "POST";

  if (get && url.pathname === "/index") return index(request, env, ctx);
  if (get && head === "disk" && id) return file(request, env, ctx, `disks/${id}`, id, "application/octet-stream");
  if (get && head === "label" && id) return file(request, env, ctx, `labels/${id}`, id, "image/png");
  if (get && head === "disks" && id) return standing(env, id);
  if (get && head === "quarantine" && id) return quarantine(env, id);
  if (post && url.pathname === "/disks") return publish(request, env, url);
  if (post && head === "report" && id) return report(request, env, url, id);
  if (post && url.pathname === "/sysop") return sysop(request, env, url);
  if (post && head === "verdict" && id) return verdict(request, env, ctx, id);
  if (get && url.pathname === "/") return answer({ exchange: "jet64", form: 1 });
  return refuse(404, "not_found", "there is nothing here");
}

// ---- Answers ---------------------------------------------------------------------------------

function answer(body: Json, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify({ status: "ok", ...body }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function refuse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ status: code, error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const now = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);

async function paused(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'paused'").first<{ v: string }>();
  return row?.v === "1";
}

// ---- Reading --------------------------------------------------------------------------------

async function index(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const key = new Request(INDEX_CACHE_KEY);
  const cached = await cache.match(key);
  if (cached) return cached;
  // The newest live upload of each maker's cart, newest first.
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.maker, d.name, d.title, d.kind, d.machine, d.bytes, d.sha256, d.version, d.checked,
            m.vouched
       FROM disks d JOIN makers m ON m.name = d.maker
      WHERE d.state = 'live'
        AND d.version = (SELECT MAX(version) FROM disks e
                          WHERE e.maker = d.maker AND e.name = d.name AND e.state = 'live')
      ORDER BY d.checked DESC LIMIT ?`,
  ).bind(INDEX_DISKS_MOST).all();
  const disks = results.map((row) => ({ ...row, vouched: row.vouched === 1 }));
  const response = answer({ disks }, 200, { "cache-control": `public, max-age=${INDEX_SECONDS}` });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

async function file(request: Request, env: Env, ctx: ExecutionContext, key: string, id: string,
                    type: string): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;
  const row = await env.DB.prepare("SELECT state, sha256 FROM disks WHERE id = ?").bind(id)
    .first<{ state: string; sha256: string }>();
  if (!row || row.state !== "live") return refuse(404, "not_found", "no such disk is on the exchange");
  const object = await env.DISKS.get(key);
  if (!object) return refuse(404, "not_found", "no such disk is on the exchange");
  // A yanked disk leaves the cache within an hour; the catalogue stops listing it at once.
  const response = new Response(object.body, {
    headers: { "content-type": type, "cache-control": "public, max-age=3600", "x-jet-sha256": row.sha256,
               "content-length": String(object.size) },
  });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

async function standing(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT id, maker, state, reason, sha256, bytes, name, title, kind, version FROM disks WHERE id = ?",
  ).bind(id).first();
  if (!row) return refuse(404, "not_found", "no such upload");
  return answer({ disk: row });
}

// ---- Publishing -----------------------------------------------------------------------------

async function publish(request: Request, env: Env, url: URL): Promise<Response> {
  if (await paused(env)) return refuse(503, "paused", "the exchange is taking no new disks just now");
  const signed = await signedBy(request, url, null);
  if (!signed.ok) return refuse(401, "unsigned", signed.why);
  const maker = url.searchParams.get("maker") ?? "";
  const size = Number(request.headers.get("content-length") ?? "NaN");
  if (!Number.isSafeInteger(size) || size <= 0) return refuse(411, "no_length", "say the disk's length");
  if (size > DISK_BYTES_MOST) return refuse(413, "too_large", `a disk may be at most ${DISK_BYTES_MOST} bytes`);
  if (!/^[0-9a-f]{64}$/.test(signed.sha256)) return refuse(400, "no_hash", "sign the disk's SHA-256");

  const claimed = await claim(env, maker, signed);
  if (claimed instanceof Response) return claimed;
  if (claimed.revoked) return refuse(403, "revoked", "this key may no longer publish");
  const young = now() - claimed.created < NEW_MAKER_SECONDS;
  if (young && size > NEW_MAKER_DISK_BYTES_MOST) {
    return refuse(413, "too_large", `in a maker's first week a disk may be at most ${NEW_MAKER_DISK_BYTES_MOST} bytes`);
  }

  const day = today();
  const ip = await hashAddress(request, env.IP_SALT ?? "");
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS all_uploads, COALESCE(SUM(bytes), 0) AS all_bytes,
            SUM(key = ?) AS by_key, SUM(ip = ?) AS by_ip
       FROM uploads WHERE day = ?`,
  ).bind(signed.key, ip, day).first<{ all_uploads: number; all_bytes: number; by_key: number; by_ip: number }>();
  if ((counts?.by_key ?? 0) >= KEY_UPLOADS_A_DAY) return refuse(429, "slow_down", "that is enough disks for today");
  if ((counts?.by_ip ?? 0) >= ADDRESS_UPLOADS_A_DAY) return refuse(429, "slow_down", "that is enough disks for today");
  if ((counts?.all_uploads ?? 0) >= UPLOADS_A_DAY || (counts?.all_bytes ?? 0) + size > UPLOAD_BYTES_A_DAY) {
    return refuse(503, "full", "the exchange has taken all it can today; please try again tomorrow");
  }
  const same = await env.DB.prepare(
    "SELECT id, state FROM disks WHERE sha256 = ? AND state IN ('checking', 'live', 'hidden')",
  ).bind(signed.sha256).first<{ id: string; state: string }>();
  if (same) return answer({ id: same.id, state: same.state, already: true });

  // Counted before R2 is touched, so a flood stops at the caps.
  const id = randomId();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO uploads (day, key, ip, bytes) VALUES (?, ?, ?, ?)").bind(day, signed.key, ip, size),
    env.DB.prepare(
      "INSERT INTO disks (id, maker, sha256, bytes, state, created) VALUES (?, ?, ?, ?, 'checking', ?)",
    ).bind(id, claimed.name, signed.sha256, size, now()),
  ]);
  // The body streams into R2; the Worker never reads it. The validator checks its hash.
  await env.DISKS.put(`disks/${id}`, request.body, { httpMetadata: { contentType: "image/png" } });
  await startValidator(env, id);
  return answer({ id, state: "checking", maker: claimed.name }, 202);
}

type Maker = { name: string; key: string; created: number; revoked: number };

// The maker a request publishes as: its key's own name, or the name it claims now.
async function claim(env: Env, maker: string, signed: { key: string }): Promise<Maker | Response> {
  const owned = await env.DB.prepare("SELECT name, key, created, revoked FROM makers WHERE key = ?")
    .bind(signed.key).first<Maker>();
  if (owned) {
    if (maker && maker !== owned.name) return refuse(409, "one_name", `this key publishes as ${owned.name}`);
    return owned;
  }
  if (!NAME_PATTERN.test(maker)) {
    return refuse(400, "bad_name", "a name is 2 to 24 lowercase letters, digits, - or _");
  }
  const folded = fold(maker);
  if (RESERVED_FOLDS.has(folded)) return refuse(409, "name_taken", "that name is kept by the machine");
  const taken = await env.DB.prepare("SELECT name FROM makers WHERE name = ? OR fold = ?").bind(maker, folded)
    .first<{ name: string }>();
  if (taken) return refuse(409, "name_taken", `that name is too like ${taken.name}, which is taken`);
  const created = now();
  await env.DB.prepare("INSERT INTO makers (name, fold, key, created) VALUES (?, ?, ?, ?)")
    .bind(maker, folded, signed.key, created).run();
  return { name: maker, key: signed.key, created, revoked: 0 };
}

// Ask GitHub to run the validator over one upload; without a token (on a
// person's own machine) the verdict is handed back by hand.
async function startValidator(env: Env, id: string): Promise<void> {
  if (!env.GITHUB_TOKEN) return;
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/check.yml/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "jet64-exchange",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main", inputs: { id } }),
    },
  );
  if (!response.ok) console.error(`the validator would not start for ${id}: ${response.status}`);
}

// ---- The validator --------------------------------------------------------------------------

async function quarantine(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT state, sha256 FROM disks WHERE id = ?").bind(id)
    .first<{ state: string; sha256: string }>();
  if (!row || row.state !== "checking") return refuse(404, "not_found", "no such disk is being checked");
  const object = await env.DISKS.get(`disks/${id}`);
  if (!object) return refuse(404, "not_found", "no such disk is being checked");
  return new Response(object.body, {
    headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-jet-sha256": row.sha256 },
  });
}

function bearerOk(request: Request, env: Env): boolean {
  const token = env.VERDICT_TOKEN;
  return !!token && request.headers.get("authorization") === `Bearer ${token}`;
}

async function verdict(request: Request, env: Env, ctx: ExecutionContext, id: string): Promise<Response> {
  if (!bearerOk(request, env)) return refuse(401, "unsigned", "only the validator hands back a verdict");
  const size = Number(request.headers.get("content-length") ?? "0");
  if (size > VERDICT_BYTES_MOST) return refuse(413, "too_large", "the verdict is too large");
  const row = await env.DB.prepare("SELECT maker, sha256, state FROM disks WHERE id = ?").bind(id)
    .first<{ maker: string; sha256: string; state: string }>();
  if (!row || row.state !== "checking") return refuse(409, "not_checking", "that disk is not being checked");
  const said = (await request.json()) as Json;

  const fail = async (reason: string) => {
    await env.DISKS.delete(`disks/${id}`);
    await env.DB.prepare("UPDATE disks SET state = 'failed', reason = ?, checked = ? WHERE id = ?")
      .bind(reason.slice(0, 200), now(), id).run();
    return answer({ id, state: "failed", reason });
  };

  if (said.ok !== true) return fail(typeof said.reason === "string" ? said.reason : "the disk did not pass");
  // The verdict is data from a job that read a stranger's file: every field is checked.
  const check = (said.check ?? {}) as Json;
  const name = String(check.name ?? ""), title = String(check.title ?? ""), kind = String(check.kind ?? "");
  const machine = String(check.machine ?? "");
  if (said.sha256 !== row.sha256) return fail("the disk is not the one its maker signed");
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(name) || title.length > 63 || !KINDS.has(kind) || !/^[0-9.]{1,15}$/.test(machine)) {
    return fail("the validator's answer did not read");
  }
  const label = Uint8Array.from(atob(String(said.label ?? "")), (c) => c.charCodeAt(0));
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (label.length > LABEL_BYTES_MOST || !pngSignature.every((b, i) => label[i] === b)) {
    return fail("the disk's label is not a small PNG");
  }
  await env.DISKS.put(`labels/${id}`, label, { httpMetadata: { contentType: "image/png" } });
  const prior = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM disks WHERE maker = ? AND name = ?")
    .bind(row.maker, name).first<{ v: number }>();
  const version = (prior?.v ?? 0) + 1;
  await env.DB.prepare(
    `UPDATE disks SET state = 'live', name = ?, title = ?, kind = ?, machine = ?, version = ?, checked = ?
      WHERE id = ?`,
  ).bind(name, title, kind, machine, version, now(), id).run();
  ctx.waitUntil(caches.default.delete(new Request(INDEX_CACHE_KEY)));
  return answer({ id, state: "live", version });
}

// ---- Reports and David's switches -----------------------------------------------------------

async function report(request: Request, env: Env, url: URL, id: string): Promise<Response> {
  const signed = await signedBy(request, url, "");
  if (!signed.ok) return refuse(401, "unsigned", signed.why);
  const row = await env.DB.prepare("SELECT state FROM disks WHERE id = ?").bind(id).first<{ state: string }>();
  if (!row || row.state !== "live") return refuse(404, "not_found", "no such disk is on the exchange");
  const ip = await hashAddress(request, env.IP_SALT ?? "");
  const put = await env.DB.prepare("INSERT OR IGNORE INTO reports (id, key, ip, created) VALUES (?, ?, ?, ?)")
    .bind(id, signed.key, ip, now()).run();
  if (put.meta.changes === 0) return answer({ id, reported: "already" });
  // Hidden only by reports from enough different keys AND enough different addresses.
  const counted = await env.DB.prepare(
    "SELECT COUNT(DISTINCT key) AS keys, COUNT(DISTINCT ip) AS ips FROM reports WHERE id = ?",
  ).bind(id).first<{ keys: number; ips: number }>();
  const hide = (counted?.keys ?? 0) >= REPORTS_THAT_HIDE && (counted?.ips ?? 0) >= REPORTS_THAT_HIDE;
  await env.DB.prepare(
    `UPDATE disks SET reports = ?, state = CASE WHEN ? THEN 'hidden' ELSE state END,
            reason = CASE WHEN ? THEN 'hidden by reports until David looks' ELSE reason END WHERE id = ?`,
  ).bind(counted?.keys ?? 0, hide ? 1 : 0, hide ? 1 : 0, id).run();
  if (hide) await caches.default.delete(new Request(INDEX_CACHE_KEY));
  return answer({ id, reported: true, hidden: hide });
}

async function sysop(request: Request, env: Env, url: URL): Promise<Response> {
  const text = await request.text();
  const signed = await signedBy(request, url, text);
  if (!signed.ok) return refuse(401, "unsigned", signed.why);
  if (signed.key !== env.SYSOP_KEY) return refuse(403, "not_sysop", "only the sysop may do that");
  const asked = JSON.parse(text) as { action?: string; id?: string; maker?: string; key?: string };
  const db = env.DB;
  const one = async (sql: string, ...values: unknown[]) => (await db.prepare(sql).bind(...values).run()).meta.changes;
  let changed = 0;
  switch (asked.action) {
    case "pause": changed = await one("INSERT OR REPLACE INTO settings (k, v) VALUES ('paused', '1')"); break;
    case "resume": changed = await one("INSERT OR REPLACE INTO settings (k, v) VALUES ('paused', '0')"); break;
    case "yank":
      changed = await one("UPDATE disks SET state = 'yanked', reason = 'yanked by David' WHERE id = ?", asked.id);
      await env.DISKS.delete([`disks/${asked.id}`, `labels/${asked.id}`]);
      break;
    case "hide": changed = await one("UPDATE disks SET state = 'hidden', reason = 'hidden by David' WHERE id = ?", asked.id); break;
    case "unhide": changed = await one("UPDATE disks SET state = 'live', reason = NULL WHERE id = ? AND state = 'hidden'", asked.id); break;
    case "vouch": changed = await one("UPDATE makers SET vouched = 1 WHERE name = ?", asked.maker); break;
    case "unvouch": changed = await one("UPDATE makers SET vouched = 0 WHERE name = ?", asked.maker); break;
    case "revoke": changed = await one("UPDATE makers SET revoked = 1 WHERE name = ?", asked.maker); break;
    // A maker who lost their key, or whose key was copied: the name moves to a new one.
    case "rekey": changed = await one("UPDATE makers SET key = ?, revoked = 0 WHERE name = ?", asked.key, asked.maker); break;
    case "hidden": {
      const { results } = await db.prepare(
        "SELECT id, maker, name, title, reports, reason FROM disks WHERE state = 'hidden' ORDER BY created DESC LIMIT 100",
      ).all();
      return answer({ hidden: results });
    }
    default: return refuse(400, "bad_action", "no such switch");
  }
  await caches.default.delete(new Request(INDEX_CACHE_KEY));
  return answer({ action: asked.action, changed });
}
