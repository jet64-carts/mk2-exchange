// mk2-exchange/src/index.ts
//
// The exchange's only door (docs/exchange.md §4 in the machine's repository).
// It never parses a disk: a disk's bytes stream past it into R2, and only the
// validator, in a GitHub Action with no secrets, opens one. Every limit is
// checked in D1 before R2 is touched, and the Worker stays on the free plan,
// which refuses past its own limits rather than billing.
//
//   GET  /index                  the catalogue, cached
//   GET  /disk/<id>              a live disk's file; counts a take for its cart
//   GET  /label/<id>             a live disk's label; a hidden one's too, signed by David's key
//   GET  /disks/<id>             where an upload stands: checking, live, failed...
//   POST /disks?maker=<name>     publish (signed; the body is the disk file)
//   POST /remove/<id>            take down a cart, every version (signed by its maker's key)
//   POST /report/<id>            report a disk (signed)
//   POST /sysop                  David's switches (signed by his key)
//   GET  /quarantine/<id>        a disk being checked, for the validator only
//   POST /verdict/<id>           the validator's verdict (bearer token)

import {
  ABOUT_CHARACTERS_MOST, ADDRESS_UPLOADS_A_DAY, DISK_BYTES_MOST, FILE_SECONDS, HIDDEN_LISTED_MOST, INDEX_DISKS_MOST,
  INDEX_SECONDS, KEY_UPLOADS_A_DAY, LABEL_BYTES_MOST, NAME_PATTERN, NEW_MAKER_DISK_BYTES_MOST, NEW_MAKER_SECONDS,
  R2_DELETE_KEYS_MOST, REPORTS_THAT_HIDE, RESERVED_FOLDS, TAKES_COUNTED_A_DAY, TITLE_CHARACTERS_MOST, UPLOAD_BYTES_A_DAY,
  UPLOADS_A_DAY, VERDICT_BYTES_MOST, fold, oneLine,
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

// Why a disk came down, as its standing says: its maker took it, or David did.
const REMOVED_BY_MAKER = "removed by its maker";
const REMOVED_BY_EXCHANGE = "removed by the exchange";

// What /index lists of a disk, read from `disks d`, `makers m` and `takes t`;
// the sysop's list of hidden disks reads the same.
const LISTED_COLUMNS =
  `d.id, d.maker, d.name, d.title, d.about, d.kind, d.machine, d.bytes, d.sha256, d.version, d.checked,
   m.vouched, COALESCE(t.takes, 0) AS takes`;
const LISTED_FROM =
  `disks d JOIN makers m ON m.name = d.maker LEFT JOIN takes t ON t.maker = d.maker AND t.name = d.name`;

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
  if (get && head === "disk" && id) return take(request, env, ctx, id);
  if (get && head === "label" && id) return label(request, env, ctx, url, id);
  if (get && head === "disks" && id) return standing(env, id);
  if (get && head === "quarantine" && id) return quarantine(env, id);
  if (post && url.pathname === "/disks") return publish(request, env, url);
  if (post && head === "remove" && id) return remove(request, env, url, id);
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
  // The newest live upload of each maker's cart, newest first, with the takes
  // of every version of that cart together.
  const { results } = await env.DB.prepare(
    `SELECT ${LISTED_COLUMNS}
       FROM ${LISTED_FROM}
      WHERE d.state = 'live'
        AND d.version = (SELECT MAX(version) FROM disks e
                          WHERE e.maker = d.maker AND e.name = d.name AND e.state = 'live')
      ORDER BY d.checked DESC LIMIT ?`,
  ).bind(INDEX_DISKS_MOST).all();
  const disks = results.map(listed);
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
    headers: { "content-type": type, "cache-control": `public, max-age=${FILE_SECONDS}`, "x-jet-sha256": row.sha256,
               "content-length": String(object.size) },
  });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

// A disk as the catalogue lists it: its maker's vouch a yes or no.
function listed(row: Record<string, unknown>): Json {
  return { ...row, vouched: row.vouched === 1 };
}

// A disk's label. A hidden disk's is shown to David alone, to judge it by: his
// request is signed as any other, with the empty body's hash, and what he is
// shown is never cached, so nobody after him meets it. Anyone else, and a
// signature that does not hold, is answered as for any label.
async function label(request: Request, env: Env, ctx: ExecutionContext, url: URL, id: string): Promise<Response> {
  if (request.headers.has("x-jet-signature")) {
    const signed = await signedBy(request, url, "");
    if (signed.ok && signed.key === env.SYSOP_KEY) {
      const row = await env.DB.prepare("SELECT state, sha256 FROM disks WHERE id = ?").bind(id)
        .first<{ state: string; sha256: string }>();
      const object = row && (row.state === "live" || row.state === "hidden") ? await env.DISKS.get(`labels/${id}`) : null;
      if (!row || !object) return refuse(404, "not_found", "no such disk is on the exchange");
      return new Response(object.body, {
        headers: { "content-type": "image/png", "cache-control": "no-store", "x-jet-sha256": row.sha256,
                   "content-length": String(object.size) },
      });
    }
  }
  return file(request, env, ctx, `labels/${id}`, id, "image/png");
}

// A live disk's file, and a take counted for its cart: after the answer is on
// its way, so nobody waits on the count.
async function take(request: Request, env: Env, ctx: ExecutionContext, id: string): Promise<Response> {
  const response = await file(request, env, ctx, `disks/${id}`, id, "application/octet-stream");
  if (response.ok && request.method === "GET") ctx.waitUntil(countTake(request, env, id));
  return response;
}

// One take for the cart a disk is a version of: at most one a cart, a computer
// and a UTC day, a computer being its address's salted hash, and none past the
// day's cap. The first statement is the whole test: it writes who took only
// when the disk is live, the day has room and this computer has not taken this
// cart today, so a take that does not count costs D1 a few rows read and none
// written. One that counts also sweeps away what earlier days kept: those rows
// are keyed by day first, so the sweep reads only what it deletes, and the cap
// bounds what one day can leave to delete. Should the second step be lost, a
// take goes uncounted; none is ever counted twice.
async function countTake(request: Request, env: Env, id: string): Promise<void> {
  const day = today();
  const ip = await hashAddress(request, env.IP_SALT ?? "");
  const cart = await env.DB.prepare(
    `INSERT OR IGNORE INTO taken (day, maker, name, ip)
     SELECT ?1, maker, name, ?2 FROM disks
      WHERE id = ?3 AND state = 'live'
        AND COALESCE((SELECT counted FROM take_days WHERE day = ?1), 0) < ?4
     RETURNING maker, name`,
  ).bind(day, ip, id, TAKES_COUNTED_A_DAY).first<{ maker: string; name: string }>();
  if (!cart) return;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO takes (maker, name, takes) VALUES (?, ?, 1)
       ON CONFLICT (maker, name) DO UPDATE SET takes = takes + 1`,
    ).bind(cart.maker, cart.name),
    env.DB.prepare(
      "INSERT INTO take_days (day, counted) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET counted = counted + 1",
    ).bind(day),
    env.DB.prepare("DELETE FROM taken WHERE day < ?").bind(day),
    env.DB.prepare("DELETE FROM take_days WHERE day < ?").bind(day),
  ]);
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

  // The day's counts, and whether David has banned this address, in one look,
  // before a name is claimed: a banned computer claims none.
  const day = today();
  const ip = await hashAddress(request, env.IP_SALT ?? "");
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS all_uploads, COALESCE(SUM(bytes), 0) AS all_bytes,
            SUM(key = ?1) AS by_key, SUM(ip = ?2) AS by_ip,
            EXISTS (SELECT 1 FROM bans WHERE ip = ?2) AS banned
       FROM uploads WHERE day = ?3`,
  ).bind(signed.key, ip, day)
    .first<{ all_uploads: number; all_bytes: number; by_key: number; by_ip: number; banned: number }>();
  if (counts?.banned) return refuse(403, "banned", "this computer may no longer publish");
  if ((counts?.by_key ?? 0) >= KEY_UPLOADS_A_DAY) return refuse(429, "slow_down", "that is enough disks for today");
  if ((counts?.by_ip ?? 0) >= ADDRESS_UPLOADS_A_DAY) return refuse(429, "slow_down", "that is enough disks for today");
  if ((counts?.all_uploads ?? 0) >= UPLOADS_A_DAY || (counts?.all_bytes ?? 0) + size > UPLOAD_BYTES_A_DAY) {
    return refuse(503, "full", "the exchange has taken all it can today; please try again tomorrow");
  }

  const claimed = await claim(env, maker, signed);
  if (claimed instanceof Response) return claimed;
  if (claimed.revoked) return refuse(403, "revoked", "this key may no longer publish");
  const young = now() - claimed.created < NEW_MAKER_SECONDS;
  if (young && size > NEW_MAKER_DISK_BYTES_MOST) {
    return refuse(413, "too_large", `in a maker's first week a disk may be at most ${NEW_MAKER_DISK_BYTES_MOST} bytes`);
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

// ---- Taking down ----------------------------------------------------------------------------

// A maker takes down their own cart. The catalogue lists each cart's newest
// live version, so taking down one version alone would bring the one before it
// back: the whole cart comes down, every version, and a disk still being
// checked (which has no cart's name yet) comes down alone.
async function remove(request: Request, env: Env, url: URL, id: string): Promise<Response> {
  const signed = await signedBy(request, url, "");
  if (!signed.ok) return refuse(401, "unsigned", signed.why);
  const row = await env.DB.prepare(
    `SELECT d.maker, d.name, m.key FROM disks d JOIN makers m ON m.name = d.maker
      WHERE d.id = ? AND d.state IN ('checking', 'live', 'hidden')`,
  ).bind(id).first<{ maker: string; name: string | null; key: string }>();
  if (!row) return refuse(404, "not_found", "no such disk is on the exchange");
  if (row.key !== signed.key) return refuse(403, "not_yours", "only its maker may remove it");
  const removed = await takeDownCart(env, id, "removed", REMOVED_BY_MAKER);
  return answer({ id, removed });
}

// Takes down the cart disk `id` is a version of, as `takeDown` does; for a
// disk not yet checked, that disk alone. How many disks came down.
async function takeDownCart(env: Env, id: string, state: string, reason: string): Promise<number> {
  return takeDown(env, state, reason,
                  "id = ?3 OR (name IS NOT NULL AND (maker, name) = (SELECT maker, name FROM disks WHERE id = ?3))", id);
}

// Every disk that `where` picks and is not down already is put in `state`, for
// `reason`; its file and label leave R2, and the catalogue's cache is dropped.
// `where` numbers what it is given from ?3, after the state and the reason. A
// disk's file and label cached nearby still leave within the hour, as `file`
// says. How many disks came down.
async function takeDown(env: Env, state: string, reason: string, where: string, ...values: unknown[]): Promise<number> {
  const { results } = await env.DB.prepare(
    `UPDATE disks SET state = ?1, reason = ?2
      WHERE state IN ('checking', 'live', 'hidden') AND (${where})
     RETURNING id`,
  ).bind(state, reason, ...values).all<{ id: string }>();
  const objects = results.flatMap(({ id }) => [`disks/${id}`, `labels/${id}`]);
  for (let at = 0; at < objects.length; at += R2_DELETE_KEYS_MOST) {
    await env.DISKS.delete(objects.slice(at, at + R2_DELETE_KEYS_MOST));
  }
  if (results.length > 0) await caches.default.delete(new Request(INDEX_CACHE_KEY));
  return results.length;
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
  const about = sentence(check.about);
  if (said.sha256 !== row.sha256) return fail("the disk is not the one its maker signed");
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(name) || !oneLine(title, TITLE_CHARACTERS_MOST) || !KINDS.has(kind) ||
      !/^[0-9.]{1,15}$/.test(machine)) {
    return fail("the validator's answer did not read");
  }
  if (about === null) {
    return fail(`what a disk says about itself is one line of at most ${ABOUT_CHARACTERS_MOST} characters`);
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
    `UPDATE disks SET state = 'live', name = ?, title = ?, about = ?, kind = ?, machine = ?, version = ?, checked = ?
      WHERE id = ?`,
  ).bind(name, title, about, kind, machine, version, now(), id).run();
  ctx.waitUntil(caches.default.delete(new Request(INDEX_CACHE_KEY)));
  return answer({ id, state: "live", version });
}

// The maker's one sentence about a disk, as a verdict gives it: trimmed, ""
// when it gives none (a validator from before disks had one sends none), and
// null when what it gives is no such sentence.
function sentence(given: unknown): string | null {
  if (given === undefined || given === null) return "";
  if (typeof given !== "string") return null;
  const words = given.trim();
  return oneLine(words, ABOUT_CHARACTERS_MOST) ? words : null;
}

// ---- Reports and David's switches -----------------------------------------------------------

async function report(request: Request, env: Env, url: URL, id: string): Promise<Response> {
  const signed = await signedBy(request, url, "");
  if (!signed.ok) return refuse(401, "unsigned", signed.why);
  const revoked = await env.DB.prepare("SELECT 1 FROM makers WHERE key = ? AND revoked = 1").bind(signed.key).first();
  if (revoked) return refuse(403, "revoked", "this key may no longer report");
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

type Asked = { action?: unknown; id?: unknown; maker?: unknown; key?: unknown; name?: unknown };

async function sysop(request: Request, env: Env, url: URL): Promise<Response> {
  const text = await request.text();
  const signed = await signedBy(request, url, text);
  if (!signed.ok) return refuse(401, "unsigned", signed.why);
  if (signed.key !== env.SYSOP_KEY) return refuse(403, "not_sysop", "only the sysop may do that");
  let asked: Asked;
  try {
    asked = JSON.parse(text);
  } catch {
    return refuse(400, "bad_action", "a switch is asked for in JSON");
  }
  if (typeof asked !== "object" || asked === null) return refuse(400, "bad_action", "no such switch");
  // What a switch names, as words: D1 takes no undefined, and a switch that
  // names nothing then changes nothing.
  const said = (value: unknown) => (typeof value === "string" ? value : "");
  const id = said(asked.id), maker = said(asked.maker);
  const db = env.DB;
  const one = async (sql: string, ...values: unknown[]) => (await db.prepare(sql).bind(...values).run()).meta.changes;
  let changed = 0;
  switch (asked.action) {
    case "pause": changed = await one("INSERT OR REPLACE INTO settings (k, v) VALUES ('paused', '1')"); break;
    case "resume": changed = await one("INSERT OR REPLACE INTO settings (k, v) VALUES ('paused', '0')"); break;
    // The whole cart the disk is a version of, as its maker would take it down
    // (`remove`); `yank` is the switch's older name, and once took one version only.
    case "remove": case "yank": changed = await takeDownCart(env, id, "yanked", REMOVED_BY_EXCHANGE); break;
    case "hide": changed = await one("UPDATE disks SET state = 'hidden', reason = 'hidden by David' WHERE id = ?", id); break;
    // A hidden disk was fine: it is live again, and the reports that hid it are
    // forgotten, so one more does not hide it again at once. `unhide` is the
    // switch's older name.
    case "keep": case "unhide": {
      changed = await one("UPDATE disks SET state = 'live', reason = NULL, reports = 0 WHERE id = ? AND state = 'hidden'", id);
      if (changed > 0) await one("DELETE FROM reports WHERE id = ?", id);
      break;
    }
    case "vouch": changed = await one("UPDATE makers SET vouched = 1 WHERE name = ?", maker); break;
    case "unvouch": changed = await one("UPDATE makers SET vouched = 0 WHERE name = ?", maker); break;
    case "revoke": changed = await one("UPDATE makers SET revoked = 1 WHERE name = ?", maker); break;
    // A maker who will not do: their key revoked, every disk of theirs taken
    // down, and every address they published from kept from publishing again.
    case "ban": {
      changed = await one("UPDATE makers SET revoked = 1 WHERE name = ?", maker);
      const disks = await takeDown(env, "yanked", REMOVED_BY_EXCHANGE, "maker = ?3", maker);
      const addresses = await one(
        `INSERT OR IGNORE INTO bans (ip, maker, created)
         SELECT DISTINCT u.ip, m.name, ? FROM uploads u JOIN makers m ON m.key = u.key WHERE m.name = ?`,
        now(), maker,
      );
      return answer({ action: asked.action, changed, disks, addresses });
    }
    // The key and the addresses may publish again; the disks taken down stay down.
    case "unban": {
      changed = await one("UPDATE makers SET revoked = 0 WHERE name = ?", maker);
      const addresses = await one("DELETE FROM bans WHERE maker = ?", maker);
      return answer({ action: asked.action, changed, addresses });
    }
    // A maker who lost their key, or whose key was copied: the name moves to a new one.
    case "rekey": changed = await one("UPDATE makers SET key = ?, revoked = 0 WHERE name = ?", said(asked.key), maker); break;
    // A cart's takes begin again at none; who took it today stays, so they are not counted twice.
    case "zero": changed = await one("DELETE FROM takes WHERE maker = ? AND name = ?", maker, said(asked.name)); break;
    // What reports have hidden, for David to keep or remove: each as the
    // catalogue would list it, with how many reported it and why it is hidden.
    case "hidden": {
      const { results } = await db.prepare(
        `SELECT ${LISTED_COLUMNS}, d.reports, d.reason
           FROM ${LISTED_FROM}
          WHERE d.state = 'hidden' ORDER BY d.created DESC LIMIT ?`,
      ).bind(HIDDEN_LISTED_MOST).all();
      return answer({ hidden: results.map(listed) });
    }
    default: return refuse(400, "bad_action", "no such switch");
  }
  await caches.default.delete(new Request(INDEX_CACHE_KEY));
  return answer({ action: asked.action, changed });
}
