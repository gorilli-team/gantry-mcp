import { canonicalize } from "../../canonical.js";
import type { CallContext } from "../../types.js";

const MAX_PREVIEW = 2000;

/**
 * Makes untrusted text safe to show: strips control and bidi-override
 * characters (which can disguise what a human approves) and caps the length.
 */
export function sanitizePreview(text: string, max = MAX_PREVIEW): string {
  const cleaned = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/[‪-‮⁦-⁩‎‏؜]/g, "");
  return cleaned.length > max ? `${cleaned.slice(0, max)}… (truncated)` : cleaned;
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
