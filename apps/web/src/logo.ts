/**
 * Original logo mark: an ember diamond. A geometric diamond (the forge)
 * holding a flame teardrop, with a rising spark. Drawn from scratch for
 * this product; it shares nothing with Appwrite, Puter, or Apper marks.
 * Uses currentColor so themes control it via CSS.
 */
export function logoSvg(size = 28, label?: string): string {
  const title = label ? `<title>${escapeHtml(label)}</title>` : "";
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="${label ? "false" : "true"}" role="img">` +
    title +
    `<path d="M16 2 30 16 16 30 2 16Z" fill="currentColor" opacity="0.16"/>` +
    `<path d="M16 2 30 16 16 30 2 16Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>` +
    `<path d="M16 9.5c2.6 3.1 4.6 5.2 4.6 8a4.6 4.6 0 1 1-9.2 0c0-2.8 2-4.9 4.6-8Z" fill="currentColor"/>` +
    `<circle cx="23.5" cy="7.5" r="1.6" fill="currentColor"/>` +
    `</svg>`
  );
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
