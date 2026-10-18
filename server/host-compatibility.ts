import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

// The plugin SDK does not expose the host version. Read only the package that
// owns this worker's entry point, rather than a CLI found on PATH or the plugin's
// development dependencies. Unknown hosts keep the legacy workaround.
export function needsMaglevWorkaround(workerEntry = process.argv[1]): boolean {
  if (!workerEntry) return true;
  let directory: string;
  try {
    directory = dirname(realpathSync(workerEntry));
  } catch {
    return true;
  }
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (manifest.name === "@getpaseo/server") {
        const version = typeof manifest.version === "string"
          ? /^(\d+)\.(\d+)\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(manifest.version)
          : null;
        if (!version) return true;
        // The split protocol validator shipped in 0.12.0-beta.1.
        return Number(version[1]) === 0 && Number(version[2]) < 12;
      }
    } catch {
      // Intermediate directories usually have no package manifest.
    }
    const parent = dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
}
