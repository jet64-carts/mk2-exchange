// mk2-exchange/src/rules.ts
//
// Every number and name the exchange is held to, in one place
// (docs/exchange.md §7 and §8 in the machine's repository).

export const MIB = 1024 * 1024;

// A disk's size at most, and at most in a key's first week.
export const DISK_BYTES_MOST = 16 * MIB;
export const NEW_MAKER_DISK_BYTES_MOST = 4 * MIB;
export const NEW_MAKER_SECONDS = 7 * 24 * 60 * 60;

// Uploads a day: a key's, an address's, and everyone's together.
export const KEY_UPLOADS_A_DAY = 10;
export const ADDRESS_UPLOADS_A_DAY = 20;
export const UPLOADS_A_DAY = 1000;
export const UPLOAD_BYTES_A_DAY = 1024 * MIB;

// Reports from different keys and different addresses that hide a disk.
export const REPORTS_THAT_HIDE = 3;

// How far a signed request's clock may stand from ours.
export const CLOCK_SLACK_SECONDS = 5 * 60;

// The largest label the validator may hand back, and the largest verdict.
export const LABEL_BYTES_MOST = 512 * 1024;
export const VERDICT_BYTES_MOST = 1 * MIB;

// The most objects R2 deletes in one call, when a cart or a maker comes down.
export const R2_DELETE_KEYS_MOST = 1000;

// How many hidden disks the sysop's list shows at once, newest first.
export const HIDDEN_LISTED_MOST = 100;

// How long the catalogue is cached, and how many disks it lists.
export const INDEX_SECONDS = 60;
export const INDEX_DISKS_MOST = 500;

// How long a disk's file and its label are cached.
export const FILE_SECONDS = 60 * 60;

// Takes counted a day, everyone's together. An address is free to change, so
// this cap and not the one take a computer carries the weight: a counted take
// writes at most four rows to D1 (who took, the cart's count, the day's count,
// and who took swept away on a later day), so a flood of them stops at a fifth
// of the 100,000 rows D1's free plan writes in a day. Past it a disk is still
// given, only not counted.
export const TAKES_COUNTED_A_DAY = 5000;

// A cart's title at most, and its maker's one sentence about it, in characters.
export const TITLE_CHARACTERS_MOST = 63;
export const ABOUT_CHARACTERS_MOST = 160;

// Whether `text` is one line of at most `most` characters: it holds no control
// character, and neither of Unicode's own line breaks.
export function oneLine(text: string, most: number): boolean {
  return !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text) && [...text].length <= most;
}

// What a signed request's message starts with: the protocol's name and form.
export const SIGNED_FORM = "jet64-exchange-1";

// A maker's name: lowercase ASCII letters, digits, - and _.
export const NAME_PATTERN = /^[a-z0-9_-]{2,24}$/;

// Names nobody may claim: the machine's words and the machine's own carts'. Its maker
// claims their own name by publishing first.
export const RESERVED_NAMES = [
  "jet64", "mk2", "sysop", "admin", "administrator", "root", "exchange", "official", "staff", "support",
  "moderator", "mod", "help", "system", "machine", "island",
  "code", "paint", "theme", "export", "shader", "tune", "sound", "scenery", "desert", "lunar", "slate",
];

// A name with its lookalikes folded together and its - and _ dropped, so
// `dav1d` meets `david` and `ace-` meets `ace`.
export function fold(name: string): string {
  return name
    .replace(/0/g, "o")
    .replace(/[1il|]/g, "l")
    .replace(/5/g, "s")
    .replace(/3/g, "e")
    .replace(/[-_]/g, "");
}

export const RESERVED_FOLDS = new Set(RESERVED_NAMES.map(fold));
