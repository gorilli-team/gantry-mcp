import { canonicalize } from "../../canonical.js";
import type { CallContext } from "../../types.js";

const MAX_PREVIEW = 2000;

// Built from strings so formatters cannot turn the escapes into invisible literals.
// biome-ignore lint/complexity/useRegexLiterals: see above.
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]", "g");
/** Zero-width, bidi-override and BOM characters that can disguise what a human approves. */
// biome-ignore lint/complexity/useRegexLiterals: see above.
const INVISIBLE = new RegExp("[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\u061c\\ufeff]", "g");
// biome-ignore lint/complexity/useRegexLiterals: see above.
const LINE_SEPARATORS = new RegExp("[\\u2028\\u2029]", "g");

export interface PreparedPreview {
  text: string;
  /** True when the text was cut. A human must never approve a partial view. */
  truncated: boolean;
}

/** Strips control and invisible characters, normalizes line separators and caps the length. */
export function preparePreview(text: string, max = MAX_PREVIEW): PreparedPreview {
  const cleaned = text.replace(LINE_SEPARATORS, "\n").replace(CONTROL, "").replace(INVISIBLE, "");
  return cleaned.length > max
    ? { text: `${cleaned.slice(0, max)}… (truncated)`, truncated: true }
    : { text: cleaned, truncated: false };
}

/** Makes untrusted text safe to show. See `preparePreview`. */
export function sanitizePreview(text: string, max = MAX_PREVIEW): string {
  return preparePreview(text, max).text;
}

export function defaultPreview(ctx: CallContext): string {
  let args: string;
  try {
    args = canonicalize(ctx.args ?? {});
  } catch {
    args = "[arguments not serializable]";
  }
  return `${ctx.tool.name} ${args}`;
}

/** Escapes text for Telegram/Slack-style Markdown. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/** Escapes text for HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
