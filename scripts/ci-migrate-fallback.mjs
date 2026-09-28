// Fallback for `wrangler d1 migrations apply` failing on files with
// CREATE TRIGGER bodies (wrangler splits statements on inner semicolons and
// the API rejects the fragments with "incomplete input: SQLITE_ERROR").
// Applies each pending file in worker/migrations via `d1 execute --file`
// (batch import, handles triggers) and records it in d1_migrations.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const DB = "invibox-db";
const CONFIG = "wrangler.production.toml";
const DIR = "worker/migrations";

import { join } from "node:path";

// Invoke wrangler directly via node so this works on Windows (.cmd
// spawning quirks) and Linux without a shell.
const WRANGLER = join("node_modules", "wrangler", "bin", "wrangler.js");
const run = (args, input) =>
  execFileSync(process.execPath, [WRANGLER, ...args], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "inherit"],
  });

const applied = new Set(
  [...JSON.parse(run(["d1", "execute", DB, "--remote", "--config", CONFIG, "--command", "SELECT name FROM d1_migrations", "--json"]))[0].results]
    .map((r) => r.name),
);

const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
let pending = 0;
for (const f of files) {
  if (applied.has(f)) continue;
  pending++;
  console.log(`applying ${f} via batch import...`);
  run(["d1", "execute", DB, "--remote", "--config", CONFIG, "--file", `${DIR}/${f}`]);
  const safe = f.replace(/'/g, "''");
  run(["d1", "execute", DB, "--remote", "--config", CONFIG, "--command", `INSERT INTO d1_migrations (name) VALUES ('${safe}')`]);
  console.log(`recorded ${f}`);
}
console.log(pending === 0 ? "no pending migrations" : `applied ${pending} migration(s)`);
