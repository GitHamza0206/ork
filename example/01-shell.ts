/**
 * Example 1 — The kernel + shell, no LLM, no network, no API key.
 *
 * This is the foundation: an in-memory virtual filesystem with a bash-subset
 * shell running entirely in-process. You seed files, run real bash (pipes,
 * redirections, globs, jq, control flow), and read the result back. Nothing
 * touches your real disk.
 *
 * Run:  pnpm -F @ork.ai/example shell      (or: tsx example/01-shell.ts)
 */
import { createKernel } from "@ork.ai/kernel";
import { Shell } from "@ork.ai/shell";

async function main() {
  // A kernel = the micro-kernel: an in-memory VFS + syscalls + quotas.
  // Seed it with some files (string or bytes). Parent dirs are auto-created.
  const kernel = createKernel({
    files: {
      "/data/users.json": JSON.stringify([
        { name: "Alice", email: "alice@acme.io", admin: true },
        { name: "Bob", email: "bob@acme.io", admin: false },
        { name: "Carol", email: "carol@acme.io", admin: true },
      ]),
      "/data/log.txt": "INFO boot\nERROR disk\nINFO ready\nERROR oom\nINFO done\n",
    },
  });

  // A shell runs bash-subset commands against that kernel's VFS.
  const shell = new Shell(kernel, { cwd: "/data" });

  // Helper to run a command and print it like a terminal session.
  const run = async (cmd: string) => {
    const { stdout, stderr, exitCode } = await shell.exec(cmd);
    console.log(`$ ${cmd}`);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stdout.write(stderr);
    if (exitCode !== 0) console.log(`  (exit ${exitCode})`);
    console.log("");
  };

  console.log("=== ork: kernel + shell, fully in-memory ===\n");

  // Plain commands, pipes, and counting.
  await run("ls -l");
  await run("grep ERROR log.txt | wc -l");

  // jq over JSON — the agent's bread and butter for inspecting data.
  await run("jq -r '.[] | select(.admin == true) | .email' users.json | sort");

  // Redirection: produce a derived artifact, then read it back.
  await run("jq -r '.[].name' users.json > /data/names.txt");
  await run("cat /data/names.txt");

  // Control flow + command substitution.
  await run('for u in $(jq -r ".[].name" users.json); do echo "hello $u"; done');

  // Write a report with a heredoc, mixing in a command substitution.
  await run(`cat > /data/report.md <<EOF
# User Report
Total users: $(jq 'length' users.json)
Admins: $(jq -r '.[] | select(.admin == true) | .name' users.json | wc -l | tr -d ' ')
EOF`);
  await run("cat /data/report.md");

  // Everything we wrote lives in the kernel VFS — read it directly, no shell.
  const report = new TextDecoder().decode(await kernel.sys.readFile("/data/report.md"));
  console.log("=== read /data/report.md straight from the VFS ===");
  console.log(report);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
