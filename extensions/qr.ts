import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import QRCode from "qrcode";

/**
 * Renders a compact terminal QR code for `text` as an array of lines, ready
 * to append to a notify message or hand to ctx.ui.setWidget. Half-block UTF-8
 * glyphs pack two pixel rows per character row, keeping the ~110-character
 * room links this renders reasonably small on screen.
 */
export async function renderQrLines(text: string): Promise<string[]> {
  const block = await QRCode.toString(text, { type: "utf8", errorCorrectionLevel: "L" });
  const lines = block.split("\n");
  while (lines.length && lines[0]!.trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

/**
 * Notifies `label: url`, plus a scannable QR code, adapting to the surface:
 * - No dialog-capable UI (print mode): the link text alone.
 * - RPC (hasUI, non-tui): the QR appended to the same notify message, since
 *   an RPC client just receives it as a string and renders it however it likes.
 * - TUI: the link via notify, and the QR in a dedicated widget so it isn't at
 *   the mercy of how the notify toast wraps or colors multi-line text.
 */
export async function announceLinkWithQr(ctx: ExtensionContext, label: string, url: string, widgetKey: string): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(`${label}: ${url}`, "info");
    return;
  }
  let qr: string[] | undefined;
  try {
    qr = await renderQrLines(url);
  } catch {
    qr = undefined;
  }
  if (!qr || qr.length === 0) {
    ctx.ui.notify(`${label}: ${url}`, "info");
    return;
  }
  if (ctx.mode === "tui") {
    ctx.ui.notify(`${label}: ${url}`, "info");
    ctx.ui.setWidget(widgetKey, qr, { placement: "belowEditor" });
  } else {
    ctx.ui.notify(`${label}: ${url}\n${qr.join("\n")}`, "info");
  }
}

/** Clears a QR widget set by announceLinkWithQr. Safe to call even if none was set. */
export function clearLinkQr(ctx: ExtensionContext, widgetKey: string): void {
  if (ctx.mode === "tui") ctx.ui.setWidget(widgetKey, undefined);
}
