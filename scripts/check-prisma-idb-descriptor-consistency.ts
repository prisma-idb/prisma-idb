/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface DescriptorGroup {
  readonly label: string;
  readonly packageDir: string;
  readonly files: readonly string[];
}

interface VersionLiteral {
  readonly version: string;
  readonly line: number;
}

interface VersionLocation {
  readonly version: string;
  readonly location: string;
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const prismaIdbRoot = join(repoRoot, "packages", "prisma-orm");

const descriptorGroups: readonly DescriptorGroup[] = [
  {
    label: "adapter-idb adapter descriptor",
    packageDir: "adapter-idb",
    files: ["src/core/descriptor-meta.ts"],
  },
  {
    label: "driver-idb driver descriptor",
    packageDir: "driver-idb",
    files: ["src/core/descriptor-meta.ts"],
  },
  {
    label: "family-idb family descriptor",
    packageDir: "family-idb",
    files: ["src/exports/pack.ts", "src/core/control-descriptor.ts"],
  },
  {
    label: "target-idb target descriptor",
    packageDir: "target-idb",
    files: ["src/core/descriptor-meta.ts"],
  },
];

const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const versionPatterns: readonly RegExp[] = [/\bversion\s*:\s*["']([^"']+)["']/g, /\bversion\s*=\s*["']([^"']+)["']/g];

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function extractVersionLiterals(source: string): VersionLiteral[] {
  const matches: VersionLiteral[] = [];

  for (const pattern of versionPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const version = match[1];
      if (version === undefined) continue;

      matches.push({
        version,
        line: lineNumberAt(source, match.index ?? 0),
      });
    }
  }

  return matches.sort((a, b) => a.line - b.line);
}

const failures: string[] = [];

for (const group of descriptorGroups) {
  const versions: VersionLocation[] = [];

  for (const file of group.files) {
    const relativePath = `${group.packageDir}/${file}`;
    const filePath = join(prismaIdbRoot, group.packageDir, file);
    const source = await readFile(filePath, "utf-8");
    const foundVersions = extractVersionLiterals(source);

    if (foundVersions.length === 0) {
      failures.push(`${relativePath} has no descriptor version literal`);
      continue;
    }

    for (const found of foundVersions) {
      versions.push({
        version: found.version,
        location: `${relativePath}:${found.line}`,
      });

      if (!semverPattern.test(found.version)) {
        failures.push(`${relativePath}:${found.line} has non-semver descriptor version ${found.version}`);
      }
    }
  }

  const uniqueVersions = new Set(versions.map((entry) => entry.version));

  if (uniqueVersions.size > 1) {
    const locations = versions.map((entry) => `${entry.location}=${entry.version}`).join(", ");
    failures.push(`${group.label} has inconsistent descriptor versions: ${locations}`);
  }
}

if (failures.length > 0) {
  console.error("Prisma IDB descriptor consistency check failed:");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log("Prisma IDB descriptor versions are internally consistent.");
