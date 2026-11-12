/**
 * Branding for the Studio frontend: the single source of truth is
 * branding.json at the repo root. Never hard-code the product name in
 * this tree (see scripts/check-branding.mjs and NAMING.md).
 */
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

export const BRANDING = brandingJson as Branding;
