#!/usr/bin/env node
// meta-mcp: configuração (setup), conferência (check) e renovação do token (renew).
// Sem argumentos, ou quando o Claude abre o programa, ele roda como servidor MCP.
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, cpSync, rmSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  saveProfile,
  configPath,
  homeDir,
  exchangeToken,
  debugToken,
  findInstagramAccounts,
  REQUIRED_SCOPES,
  fmtDate,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = "github:alissonjcdev/meta-mcp";

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("-"));
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const profileName = opt("profile") || "default";

const say = (m = "") => process.stdout.write(m + "\n");
const fail = (m) => {
  process.stderr.write(`\n${m}\n`);
  process.exit(1);
};

// ---------- entrada de texto ----------

// Uma única interface para a sessão toda: com entrada colada de uma vez (pipe),
// cada linha vai para a pergunta certa, em ordem.
let rl = null;
let muted = false;
const pending = [];
const waiting = [];

function input() {
  if (rl) return rl;
  const tty = Boolean(process.stdin.isTTY);
  rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => {
    // Durante uma pergunta oculta, troca o que a pessoa cola por asteriscos.
    if (!muted) return write(s);
    if (s.includes("\n") || s.includes("\r")) return write("\n");
    write("*".repeat(s.length));
  };
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else pending.push(line);
  });
  rl.on("close", () => {
    while (waiting.length) waiting.shift()("");
  });
  return rl;
}

export function closeInput() {
  if (rl) rl.close();
  rl = null;
}

function ask(question, { hidden = false } = {}) {
  const r = input();
  muted = false;
  process.stdout.write(question);
  if (hidden && process.stdin.isTTY) muted = true;
  return new Promise((done) => {
    const finish = (answer) => {
      muted = false;
      done(String(answer).trim());
    };
    if (pending.length) finish(pending.shift());
    else waiting.push(finish);
    r.resume();
  });
}

async function askUntil(question, check, opts) {
  for (;;) {
    const v = await ask(question, opts);
    const err = check(v);
    if (!err) return v;
    say(`     ${err}`);
  }
}

// ---------- Claude Desktop ----------

export function claudeDesktopConfigPath() {
  if (process.env.CLAUDE_DESKTOP_CONFIG) return process.env.CLAUDE_DESKTOP_CONFIG;
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

// Quando roda pelo npx, o programa fica numa pasta temporária do npm. Copiamos para ~/.meta-mcp/app
// para o Claude sempre achar o servidor, mesmo se o cache do npm for limpo.
export function installServer() {
  const parent = dirname(HERE);
  if (basename(parent) !== "node_modules" || flag("no-copy")) return join(HERE, "server.mjs");
  const target = join(homeDir(), "app", "node_modules");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(parent, target, { recursive: true, dereference: true });
  return join(target, basename(HERE), "server.mjs");
}

export function writeClaudeDesktop(serverPath, file = claudeDesktopConfigPath()) {
  let cfg = {};
  let backup = null;
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    try {
      cfg = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`O arquivo ${file} existe mas não é um JSON válido. Corrija ou apague e rode o setup de novo.`);
    }
    backup = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(file, backup);
  }
  cfg.mcpServers = { ...(cfg.mcpServers || {}), meta: { command: process.execPath, args: [serverPath] } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return { file, backup };
}

// ---------- etapas ----------

async function connectToken({ app_id, app_secret, shortToken }) {
  process.stdout.write("\nConferindo o token... ");
  const before = await debugToken({ app_id, app_secret, token: shortToken });
  if (!before.is_valid) fail(`O token não é válido: ${before.error?.message || "a Meta recusou"}. Gere outro no Explorador da Graph API.`);
  if (String(before.app_id) !== String(app_id)) fail(`Esse token é de outro app (${before.app_id}). No Explorador, escolha o seu app antes de gerar o token.`);
  say("ok");

  const missing = REQUIRED_SCOPES.filter((s) => !(before.scopes || []).includes(s));
  if (missing.length) {
    say(`\nAtenção: faltam estas permissões no token: ${missing.join(", ")}`);
    say("Dá para seguir, mas algumas funções não vão funcionar. Para incluir, gere o token de novo marcando essas permissões.");
  }

  process.stdout.write("Trocando por um token de 60 dias... ");
  const long = await exchangeToken({ app_id, app_secret, token: shortToken });
  const after = await debugToken({ app_id, app_secret, token: long.access_token });
  say(`ok (vale até ${fmtDate(after.expires_at || (long.expires_in ? Date.now() / 1000 + long.expires_in : 0))})`);
  return { token: long.access_token, token_expires_at: after.expires_at || null, scopes: after.scopes || [] };
}

async function pickInstagram(token, app_secret) {
  process.stdout.write("Procurando sua conta do Instagram... ");
  const accounts = await findInstagramAccounts(token, app_secret);
  if (!accounts.length) {
    say("nenhuma");
    fail(
      "Não achei nenhuma conta do Instagram ligada às suas Páginas.\n" +
        "Confira: (1) o Instagram é conta Profissional (Criador ou Empresa); (2) ele está ligado a uma Página do Facebook;\n" +
        "(3) ao gerar o token, você marcou essa Página e essa conta. Depois rode o setup de novo."
    );
  }
  say(accounts.length === 1 ? "achei" : `achei ${accounts.length}`);
  if (accounts.length === 1) return accounts[0];
  accounts.forEach((a, i) => say(`  ${i + 1}) @${a.ig_username}  (Página: ${a.page_name})`));
  const n = await askUntil("Qual delas? Digite o número: ", (v) => (Number(v) >= 1 && Number(v) <= accounts.length ? null : "Número inválido."));
  return accounts[Number(n) - 1];
}

function finish(account, { writeDesktop = true } = {}) {
  say(`\nConectado: @${account.ig_username} (Página: ${account.page_name})`);
  say(`Configuração salva em ${configPath()}`);
  if (writeDesktop && !flag("no-desktop")) {
    const serverPath = installServer();
    try {
      const { file, backup } = writeClaudeDesktop(serverPath);
      say(`\nClaude Desktop configurado: ${file}`);
      if (backup) say(`Cópia do arquivo anterior: ${backup}`);
      say("Agora feche o Claude Desktop por completo e abra de novo.");
    } catch (e) {
      say(`\nNão consegui configurar o Claude Desktop sozinho: ${e.message}`);
    }
    say("\nUsa o Claude Code no terminal? Rode também:");
    say(`  claude mcp add --scope user meta -- "${process.execPath}" "${serverPath}"`);
  }
  say("\nPronto. No Claude, peça: \"Como foi meu Instagram nos últimos 7 dias?\"");
}

// ---------- comandos ----------

async function setup() {
  say("meta-mcp · conectar o Claude ao seu Instagram\n");
  say("Vou te pedir 3 coisas do painel da Meta (developers.facebook.com).");
  say(`Elas ficam só neste computador, em ${configPath()}.\n`);

  const prev = loadConfig().profiles[profileName] || {};
  const app_id = await askUntil(
    `1/3  App ID${prev.app_id ? ` [Enter = ${prev.app_id}]` : ""}: `,
    (v) => (/^\d{6,20}$/.test(v || prev.app_id || "") ? null : "O App ID tem só números. Fica em Configurações do app > Básico.")
  ).then((v) => v || prev.app_id);
  const app_secret = await askUntil(
    "2/3  Chave secreta do app (App Secret): ",
    (v) => (/^[a-f0-9]{32}$/i.test(v) ? null : "A chave secreta tem 32 letras e números. Clique em Mostrar ao lado dela e copie de novo."),
    { hidden: true }
  );
  const shortToken = await askUntil(
    "3/3  Token de acesso (do Explorador da Graph API): ",
    (v) => (/^EA[A-Za-z0-9]{20,}$/.test(v) ? null : "O token começa com EA e é bem longo. Copie de novo pelo botão de copiar do Explorador."),
    { hidden: true }
  );

  try {
    const tok = await connectToken({ app_id, app_secret, shortToken });
    const account = await pickInstagram(tok.token, app_secret);
    saveProfile(profileName, { app_id, app_secret, ...tok, ...account, updated_at: new Date().toISOString() });
    finish(account);
  } catch (e) {
    fail(e.message);
  }
}

async function renew() {
  const p = loadConfig().profiles[profileName];
  if (!p?.app_id || !p?.app_secret) fail("Ainda não tem nada configurado. Rode primeiro: meta-mcp setup");
  say("meta-mcp · renovar o token\n");
  say("Gere um token novo no Explorador da Graph API (mesmo app, mesmas permissões) e cole aqui.\n");
  const shortToken = await askUntil(
    "Token de acesso: ",
    (v) => (/^EA[A-Za-z0-9]{20,}$/.test(v) ? null : "O token começa com EA e é bem longo. Copie de novo."),
    { hidden: true }
  );
  try {
    const tok = await connectToken({ app_id: p.app_id, app_secret: p.app_secret, shortToken });
    saveProfile(profileName, { ...tok, updated_at: new Date().toISOString() });
    say(`\nToken renovado para @${p.ig_username}. Não precisa mexer no Claude.`);
  } catch (e) {
    fail(e.message);
  }
}

async function check() {
  const p = loadConfig().profiles[profileName];
  if (!p?.token) fail("Ainda não tem nada configurado. Rode primeiro: meta-mcp setup");
  say(`Configuração: ${configPath()}`);
  try {
    const d = await debugToken(p);
    const days = d.expires_at ? Math.round((d.expires_at - Date.now() / 1000) / 86400) : null;
    say(`Instagram: @${p.ig_username} (Página: ${p.page_name})`);
    say(`Token: ${d.is_valid ? "válido" : "INVÁLIDO"}${d.expires_at === 0 ? ", não expira" : d.expires_at ? `, vale até ${fmtDate(d.expires_at)} (${days} dias)` : ""}`);
    const missing = REQUIRED_SCOPES.filter((s) => !(d.scopes || []).includes(s));
    say(missing.length ? `Permissões que faltam: ${missing.join(", ")}` : "Permissões: todas ok");
    if (!d.is_valid || (days !== null && days < 7)) say("\nRenove com: meta-mcp renew");
    if (!d.is_valid) process.exit(1);
  } catch (e) {
    fail(e.message);
  }
}

function help() {
  say(`meta-mcp · conecte o Claude ao seu Instagram pela API oficial da Meta

Comandos:
  setup     conecta sua conta (pede App ID, chave secreta e token) e configura o Claude Desktop
  check     confere se o token está válido e até quando vale
  renew     troca por um token novo quando o atual vencer (a cada ~60 dias)
  server    roda o servidor MCP (é o que o Claude usa; você não precisa rodar)

Opções:
  --profile=nome   guarda mais de uma conta (padrão: default)
  --no-desktop     não mexe na configuração do Claude Desktop

Exemplo:
  npx -y ${REPO} setup`);
}

// npx chama pelo atalho em node_modules/.bin, então comparamos o caminho real.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  if (flag("help") || flag("h") || cmd === "help") help();
  // Pessoa abriu no terminal sem comando: mostra a ajuda. O Claude abre sem terminal: vira servidor.
  else if (!cmd && process.stdin.isTTY) help();
  else if (cmd === "setup") {
    await setup();
    closeInput();
  } else if (cmd === "renew") {
    await renew();
    closeInput();
  }
  else if (cmd === "check") await check();
  else if (!cmd || cmd === "server") await import("./server.mjs");
  else {
    say(`Comando desconhecido: ${cmd}\n`);
    help();
    process.exit(1);
  }
}
