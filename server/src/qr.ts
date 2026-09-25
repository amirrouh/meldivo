import QRCode from "qrcode";

/**
 * Renders `text` as a compact terminal QR code (half-block UTF-8 glyphs,
 * packing two pixel rows per character row), ready to print alongside a hub
 * URL from the CLI.
 */
export async function qrText(url: string): Promise<string> {
  const block = await QRCode.toString(url, { type: "utf8", errorCorrectionLevel: "L" });
  const lines = block.split("\n");
  while (lines.length && lines[0]!.trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.join("\n");
}
