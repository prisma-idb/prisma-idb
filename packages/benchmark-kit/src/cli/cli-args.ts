type CliArgValue = string | boolean;

export function parseArgs(argv: string[]): Record<string, CliArgValue> {
  const parsed: Record<string, CliArgValue> = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const raw = token.slice(2);
    const equalsIndex = raw.indexOf("=");
    if (equalsIndex >= 0) {
      const key = raw.slice(0, equalsIndex);
      const value = raw.slice(equalsIndex + 1);
      parsed[key] = value;
      continue;
    }

    const key = raw;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

export function getStringArg(args: Record<string, CliArgValue>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function hasFlag(args: Record<string, CliArgValue>, key: string): boolean {
  return args[key] === true;
}
