import brandingJson from "../../../branding.json";

export interface Branding {
  binaryName: string;
  configDir: string;
  defaultHost: string;
  description: string;
  desktopId: string;
  envPrefix: string;
  homepage: string;
  mcpLegacySsePath: string;
  mcpPath: string;
  name: string;
  repository: string;
  slug: string;
  supportEmail: string;
  tagline: string;
  version: string;
  workingTitle: boolean;
}

/**
 * Single source of truth for product identity. Every surface (server, MCP,
 * Studio, eject templates, docs generators) reads this file. Nothing else in
 * the codebase may hard-code the product name. See NAMING.md: the working
 * title is NOT cleared for public use.
 */
export const BRANDING: Branding = brandingJson as Branding;

export function mcpConnectUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}${BRANDING.mcpPath}`;
}

export function mcpLegacySseUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}${BRANDING.mcpLegacySsePath}`;
}
