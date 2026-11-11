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

// How long the catalogue is cached, and how many disks it lists.
export const INDEX_SECONDS = 60;
export const INDEX_DISKS_MOST = 500;

// What a signed request's message starts with: the protocol's name and form.
export const SIGNED_FORM = "jet64-exchange-1";

// A maker's name: lowercase ASCII letters, digits, - and _.
export const NAME_PATTERN = /^[a-z0-9_-]{2,24}$/;

// Names nobody may claim: the machine's, its maker's handle, and the machine's own carts'.
export const RESERVED_NAMES = [
  "jet64", "mk2", "sysop", "admin", "administrator", "root", "exchange", "official", "staff", "support",
  "moderator", "mod", "help", "system", "machine", "island", "73v3",
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
