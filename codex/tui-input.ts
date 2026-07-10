import { StringDecoder } from "node:string_decoder";

const ESC = "\x1b";
const ALT_MODIFIER_BIT = 0b10;
const LOCK_MODIFIER_BITS = 0b1100_0000;
const DISALLOWED_MODIFIER_BITS = 0b0011_1101;
const KEY_I = 105;
const KEY_M = 109;

export interface FilteredTuiInput {
  forwarded: string;
  pending: string;
  altICount: number;
  altMCount: number;
}

interface ShortcutMatch {
  consume: boolean;
  trigger: boolean;
}

function parseNumber(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isAltOnlyModifier(encodedModifier: number): boolean {
  const bits = encodedModifier - 1;
  if (bits < 0 || (bits & ALT_MODIFIER_BIT) === 0) return false;
  return (bits & DISALLOWED_MODIFIER_BITS) === 0
    && (bits & ~(ALT_MODIFIER_BIT | LOCK_MODIFIER_BITS)) === 0;
}

function matchKittyAltKey(sequence: string, key: number): ShortcutMatch {
  if (!sequence.endsWith("u")) return { consume: false, trigger: false };
  const params = sequence.slice(2, -1).split(";");
  if (params.length < 2) return { consume: false, trigger: false };

  const keyParts = params[0].split(":");
  const primaryKey = parseNumber(keyParts[0]);
  const baseLayoutKey = parseNumber(keyParts[2]);
  const modifierParts = params[1].split(":");
  const modifier = parseNumber(modifierParts[0]);
  const eventType = modifierParts[1] === undefined ? 1 : parseNumber(modifierParts[1]);
  if (modifier === null || eventType === null || !isAltOnlyModifier(modifier)) {
    return { consume: false, trigger: false };
  }

  if (primaryKey !== key && baseLayoutKey !== key) {
    return { consume: false, trigger: false };
  }

  // Consume repeat/release events for the shortcut, but trigger only on press.
  return { consume: true, trigger: eventType === 1 };
}

function matchModifyOtherKeysAltKey(sequence: string, expectedKey: number): ShortcutMatch {
  if (!sequence.endsWith("~")) return { consume: false, trigger: false };
  const params = sequence.slice(2, -1).split(";");
  if (params.length !== 3 || params[0] !== "27") return { consume: false, trigger: false };
  const modifier = parseNumber(params[1]);
  const key = parseNumber(params[2]);
  const matches = modifier !== null && key === expectedKey && isAltOnlyModifier(modifier);
  return { consume: matches, trigger: matches };
}

function matchAltKeySequence(sequence: string, key: number): ShortcutMatch {
  if (sequence === `${ESC}${String.fromCharCode(key)}`) return { consume: true, trigger: true };
  if (!sequence.startsWith(`${ESC}[`)) return { consume: false, trigger: false };
  if (sequence.endsWith("u")) return matchKittyAltKey(sequence, key);
  if (sequence.endsWith("~")) return matchModifyOtherKeysAltKey(sequence, key);
  return { consume: false, trigger: false };
}

function findCsiEnd(source: string, start: number): number {
  for (let index = start + 2; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return -1;
}

/**
 * Remove semantic Alt+I key events while preserving all other terminal input.
 * `pending` carries a partial escape sequence across input chunks.
 */
export function filterAltIInput(input: string, pending = ""): FilteredTuiInput {
  const source = pending + input;
  let forwarded = "";
  let altICount = 0;
  let altMCount = 0;
  let index = 0;

  while (index < source.length) {
    if (source[index] !== ESC) {
      forwarded += source[index];
      index += 1;
      continue;
    }

    if (index + 1 >= source.length) {
      return { forwarded, pending: source.slice(index), altICount, altMCount };
    }

    if (source[index + 1] === "i") {
      altICount += 1;
      index += 2;
      continue;
    }
    if (source[index + 1] === "m") {
      altMCount += 1;
      index += 2;
      continue;
    }

    if (source[index + 1] !== "[") {
      forwarded += source[index];
      index += 1;
      continue;
    }

    const end = findCsiEnd(source, index);
    if (end === -1) {
      return { forwarded, pending: source.slice(index), altICount, altMCount };
    }

    const sequence = source.slice(index, end + 1);
    const altI = matchAltKeySequence(sequence, KEY_I);
    const altM = matchAltKeySequence(sequence, KEY_M);
    if (altI.consume || altM.consume) {
      if (altI.trigger) altICount += 1;
      if (altM.trigger) altMCount += 1;
    } else {
      forwarded += sequence;
    }
    index = end + 1;
  }

  return { forwarded, pending: "", altICount, altMCount };
}

/** UTF-8-safe stateful wrapper for terminal chunks and partial escape sequences. */
export class TuiInputDecoder {
  private readonly utf8 = new StringDecoder("utf8");
  private pending = "";

  write(chunk: Buffer | string): Omit<FilteredTuiInput, "pending"> {
    const text = typeof chunk === "string" ? chunk : this.utf8.write(chunk);
    const filtered = filterAltIInput(text, this.pending);
    this.pending = filtered.pending;
    return { forwarded: filtered.forwarded, altICount: filtered.altICount, altMCount: filtered.altMCount };
  }

  hasPendingEscape(): boolean {
    return this.pending.length > 0;
  }

  flushPendingEscape(): string {
    const pending = this.pending;
    this.pending = "";
    return pending;
  }

  end(): Omit<FilteredTuiInput, "pending"> {
    const filtered = filterAltIInput(this.utf8.end(), this.pending);
    this.pending = "";
    return {
      forwarded: filtered.forwarded + filtered.pending,
      altICount: filtered.altICount,
      altMCount: filtered.altMCount,
    };
  }
}
