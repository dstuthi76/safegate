import * as fs from "fs";
import * as path from "path";

/** Converts a simple glob (supports **, *, ?) into a RegExp matched against forward-slash relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more directories
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export function matchesAny(relPath: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(relPath));
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Recursively lists files under root whose extension is in exts, skipping ignored globs. */
export function walk(root: string, exts: string[], ignore: string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        if (matchesAny(rel + "/", ignore) || matchesAny(rel + "/x", ignore)) continue;
        visit(abs);
      } else if (entry.isFile()) {
        if (!exts.some((e) => entry.name.endsWith(e))) continue;
        if (matchesAny(rel, ignore)) continue;
        try {
          if (fs.statSync(abs).size > 1_500_000) continue; // generated or minified bundles
        } catch {
          continue;
        }
        out.push(abs);
      }
    }
  };
  visit(root);
  return out.sort();
}

/** 1-based line number of a character offset. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
