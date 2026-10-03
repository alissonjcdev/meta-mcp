import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(args, input, env) {
  return spawnSync(process.execPath, ["--import", join(ROOT, "test/fake-meta.mjs"), join(ROOT, "cli.mjs"), ...args], {
    input,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("setup salva o config, preserva o Claude Desktop e faz backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "meta-mcp-"));
  const desktop = join(dir, "claude.json");
  writeFileSync(desktop, JSON.stringify({ mcpServers: { outro: { command: "x" } }, tema: "escuro" }));
  const env = { META_MCP_HOME: join(dir, "home"), CLAUDE_DESKTOP_CONFIG: desktop };
  const r = run(["setup"], "1234567890\n" + "a".repeat(32) + "\nEAASHORTTOKEN000000000000000\n", env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Conectado: @cafeteria\.teste/);
  assert.match(r.stdout, /faltam estas permissões/);

  const cfg = JSON.parse(readFileSync(join(dir, "home", "config.json"), "utf8"));
  assert.equal(cfg.default, "default");
  assert.equal(cfg.profiles.default.token, "EAALONGTOKEN0000000000000000");
  assert.equal(cfg.profiles.default.ig_user_id, "999");
  assert.equal(cfg.profiles.default.page_id, "111");
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "home", "config.json")).mode & 0o777, 0o600);

  const d = JSON.parse(readFileSync(desktop, "utf8"));
  assert.equal(d.tema, "escuro");
  assert.equal(d.mcpServers.outro.command, "x");
  assert.equal(d.mcpServers.meta.command, process.execPath);
  assert.match(d.mcpServers.meta.args[0], /server\.mjs$/);
  assert.ok(readdirSync(dir).some((f) => f.startsWith("claude.json.backup-")));
  assert.ok(!r.stdout.includes("EAASHORTTOKEN"), "token não pode aparecer na tela");
});

test("setup rejeita App ID inválido e pergunta de novo", () => {
  const dir = mkdtempSync(join(tmpdir(), "meta-mcp-"));
  const env = { META_MCP_HOME: join(dir, "home"), CLAUDE_DESKTOP_CONFIG: join(dir, "claude.json") };
  const r = run(["setup"], "abc\n1234567890\n" + "a".repeat(32) + "\nEAASHORTTOKEN000000000000000\n", env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /O App ID tem só números/);
});

test("check sem configuração sai com erro amigável", () => {
  const dir = mkdtempSync(join(tmpdir(), "meta-mcp-"));
  const r = run(["check"], "", { META_MCP_HOME: join(dir, "home") });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Rode primeiro: meta-mcp setup/);
});
