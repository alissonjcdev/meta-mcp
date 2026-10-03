// Núcleo compartilhado entre o servidor MCP e o CLI: configuração local e chamadas à Graph API da Meta.
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const DEFAULT_VERSION = process.env.META_GRAPH_VERSION || "v26.0";

// Tudo fica num arquivo só, na pasta do usuário: ~/.meta-mcp/config.json
// (no Windows, %USERPROFILE%\.meta-mcp\config.json). Dá para trocar com META_MCP_HOME.
export const homeDir = () => process.env.META_MCP_HOME || join(homedir(), ".meta-mcp");
export const configPath = () => join(homeDir(), "config.json");

// Formato:
// { "default": "default", "profiles": { "default": { app_id, app_secret, token, token_expires_at,
//   ig_user_id, ig_username, page_id, page_name } } }
export function loadConfig() {
  const file = configPath();
  if (!existsSync(file)) return { default: null, profiles: {} };
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  return { default: cfg.default || null, profiles: cfg.profiles || {} };
}

export function saveConfig(cfg) {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync só aplica o modo ao criar; garante 600 em arquivo antigo. No Windows é ignorado.
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

export function saveProfile(name, data) {
  const cfg = loadConfig();
  cfg.profiles[name] = { ...(cfg.profiles[name] || {}), ...data };
  if (!cfg.default) cfg.default = name;
  saveConfig(cfg);
  return cfg.profiles[name];
}

// Variáveis de ambiente têm prioridade sobre o arquivo (útil em servidor/CI).
function envProfile() {
  if (!process.env.META_ACCESS_TOKEN) return null;
  return {
    name: "env",
    token: process.env.META_ACCESS_TOKEN,
    app_id: process.env.META_APP_ID,
    app_secret: process.env.META_APP_SECRET,
    ig_user_id: process.env.META_IG_USER_ID,
    page_id: process.env.META_PAGE_ID,
  };
}

export function resolveProfile(name) {
  if (!name) {
    const env = envProfile();
    if (env) return env;
  }
  const cfg = loadConfig();
  const profile = name || cfg.default;
  if (!profile) throw new Error("Nada configurado ainda. Rode o comando de configuração: npx -y github:alissonjcdev/meta-mcp setup");
  const p = cfg.profiles[profile];
  if (!p) throw new Error(`Perfil "${profile}" não existe. Perfis: ${Object.keys(cfg.profiles).join(", ") || "(nenhum)"}`);
  if (!p.token) throw new Error(`Perfil "${profile}" sem token. Rode: meta-mcp setup`);
  return { name: profile, ...p };
}

// Token de app (app_id|app_secret), usado no debug_token e na troca por token longo.
export function appToken(p) {
  if (!p.app_id || !p.app_secret) throw new Error("Falta o App ID ou o App Secret. Rode: meta-mcp setup");
  return `${p.app_id}|${p.app_secret}`;
}

const pageTokenCache = new Map();

// Token de página, necessário para Direct e respostas privadas do Instagram.
export async function pageToken(pageId, profileName) {
  const key = `${profileName || ""}:${pageId}`;
  if (pageTokenCache.has(key)) return pageTokenCache.get(key);
  const res = await graph({ path: pageId, params: { fields: "access_token" }, profile: profileName });
  if (!res.ok || !res.data?.access_token) throw new Error(`Não consegui o token da página ${pageId}: ${JSON.stringify(res.data?.error || res.data)}`);
  pageTokenCache.set(key, res.data.access_token);
  return res.data.access_token;
}

export async function graph({ method = "GET", path, params = {}, body, profile, token, version, appSecret }) {
  let accessToken = token;
  let proofSecret = appSecret || null;
  if (!accessToken) {
    const p = resolveProfile(profile);
    accessToken = p.token;
    proofSecret = p.app_secret || null;
  }
  const cleanPath = String(path).replace(/^https:\/\/graph\.facebook\.com\//, "").replace(/^\/+/, "");
  const hasVersion = /^v\d+\.\d+\//.test(cleanPath);
  const url = new URL(`https://graph.facebook.com/${hasVersion ? "" : (version || DEFAULT_VERSION) + "/"}${cleanPath}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  // appsecret_proof deixa o token inútil para quem não tem o secret; não atrapalha quando o app não exige.
  if (proofSecret && !accessToken.includes("|")) {
    url.searchParams.set("appsecret_proof", createHmac("sha256", proofSecret).update(accessToken).digest("hex"));
  }
  const init = { method: method.toUpperCase(), headers: { Authorization: `Bearer ${accessToken}` } };
  if (body !== undefined && init.method !== "GET") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(url, init);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { ok: resp.ok, status: resp.status, data };
}

// Segue paging.next até `limit` itens.
export async function graphAll(opts, limit = 500) {
  const out = [];
  let res = await graph(opts);
  while (res.ok) {
    out.push(...(res.data?.data || []));
    const next = res.data?.paging?.next;
    if (!next || out.length >= limit) break;
    const u = new URL(next);
    u.searchParams.delete("access_token");
    u.searchParams.delete("appsecret_proof");
    res = await graph({ ...opts, path: u.pathname.slice(1), params: Object.fromEntries(u.searchParams) });
  }
  if (!res.ok) return { ok: false, status: res.status, data: res.data, partial: out };
  return { ok: true, data: out.slice(0, limit) };
}

// Permissões que o guia pede no Explorador da Graph API.
export const REQUIRED_SCOPES = [
  "instagram_basic",
  "instagram_manage_insights",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_messages",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
];

// Troca o token curto (1 a 2 horas) por um de cerca de 60 dias.
export async function exchangeToken({ app_id, app_secret, token }) {
  const r = await graph({
    path: "oauth/access_token",
    params: { grant_type: "fb_exchange_token", client_id: app_id, client_secret: app_secret, fb_exchange_token: token },
    token: `${app_id}|${app_secret}`,
  });
  if (!r.ok || !r.data?.access_token) throw new Error(metaError(r.data, "A Meta recusou a troca do token"));
  return r.data;
}

export async function debugToken({ app_id, app_secret, token }) {
  const r = await graph({ path: "debug_token", params: { input_token: token }, token: `${app_id}|${app_secret}` });
  if (!r.ok) throw new Error(metaError(r.data, "Não consegui conferir o token"));
  return r.data?.data || {};
}

// Páginas do usuário com a conta do Instagram profissional ligada (quando houver).
export async function findInstagramAccounts(token, appSecret) {
  const r = await graph({
    path: "me/accounts",
    params: { fields: "id,name,instagram_business_account{id,username,name,followers_count}", limit: 100 },
    token,
    appSecret,
  });
  if (!r.ok) throw new Error(metaError(r.data, "Não consegui listar suas Páginas"));
  return (r.data?.data || [])
    .filter((pg) => pg.instagram_business_account)
    .map((pg) => ({
      page_id: pg.id,
      page_name: pg.name,
      ig_user_id: pg.instagram_business_account.id,
      ig_username: pg.instagram_business_account.username,
      followers: pg.instagram_business_account.followers_count,
    }));
}

export function metaError(data, prefix = "Erro da Meta") {
  const e = data?.error;
  if (!e) return `${prefix}: ${typeof data === "string" ? data : JSON.stringify(data)}`;
  return `${prefix}: ${e.message}${e.code ? ` (código ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""})` : ""}`;
}

export const fmtDate = (unix) => (unix ? new Date(unix * 1000).toLocaleDateString("pt-BR") : "?");
