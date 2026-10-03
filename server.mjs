#!/usr/bin/env node
// MCP da Meta com foco em Instagram: números, análise de perfis, publicação, comentários e Direct,
// tudo pela Graph API oficial.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { graph, graphAll, loadConfig, resolveProfile, appToken, pageToken, metaError, DEFAULT_VERSION, REQUIRED_SCOPES } from "./lib.mjs";

const server = new McpServer({ name: "meta", version: "1.0.0" });

const profileArg = z.string().optional().describe("Perfil configurado. Omitido = perfil padrão (quase sempre é o que você quer).");
const igArg = z.string().optional().describe("ID da conta do Instagram. Omitido = a conta escolhida no setup.");

const reply = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
  isError: obj && typeof obj === "object" && obj.ok === false,
});

const safe = (fn) => async (args) => {
  try {
    return reply(await fn(args));
  } catch (e) {
    return reply({ ok: false, error: e.message });
  }
};

function igId(ig_user_id, profile) {
  const id = ig_user_id || resolveProfile(profile).ig_user_id;
  if (!id) throw new Error("Nenhuma conta do Instagram escolhida. Rode ig_accounts e passe ig_user_id, ou refaça o setup.");
  return id;
}

function pageId(page_id, profile) {
  const id = page_id || resolveProfile(profile).page_id;
  if (!id) throw new Error("Nenhuma Página ligada. Rode ig_accounts e passe page_id, ou refaça o setup.");
  return id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Geral ----------

server.registerTool(
  "meta_status",
  {
    description:
      "Mostra o que está configurado e se o token está válido: conta do Instagram, Página, validade e permissões que faltam. Use primeiro quando algo der erro.",
    inputSchema: { profile: profileArg },
  },
  safe(async ({ profile }) => {
    const cfg = loadConfig();
    const p = resolveProfile(profile);
    const out = {
      profile: p.name,
      profiles: Object.keys(cfg.profiles),
      graph_version: DEFAULT_VERSION,
      instagram: p.ig_username ? `@${p.ig_username} (${p.ig_user_id})` : null,
      page: p.page_name ? `${p.page_name} (${p.page_id})` : null,
    };
    if (p.app_id && p.app_secret) {
      const dbg = await graph({ path: "debug_token", params: { input_token: p.token }, token: appToken(p) });
      const d = dbg.data?.data || {};
      out.valid = d.is_valid;
      out.expires = d.expires_at === 0 ? "nunca" : d.expires_at ? new Date(d.expires_at * 1000).toISOString() : undefined;
      out.scopes = d.scopes;
      out.missing_scopes = REQUIRED_SCOPES.filter((s) => !(d.scopes || []).includes(s));
      if (!dbg.ok) out.error = metaError(dbg.data);
    } else {
      const me = await graph({ path: "me", params: { fields: "id,name" }, profile });
      out.valid = me.ok;
      if (!me.ok) out.error = metaError(me.data);
    }
    return out;
  })
);

server.registerTool(
  "graph_request",
  {
    description:
      "Chamada livre à Graph API (graph.facebook.com) para qualquer endpoint que não tenha atalho aqui. " +
      "path sem versão (ex.: '{ig_user_id}/tags' ou '{media_id}?fields=caption'). " +
      "token_kind 'page' usa o token da Página (page_id). " +
      "POST e DELETE mudam coisas reais (publicar, apagar, enviar): confirme com o usuário antes.",
    inputSchema: {
      method: z.enum(["GET", "POST", "DELETE"]).default("GET"),
      path: z.string(),
      params: z.record(z.string(), z.any()).optional().describe("Query string (fields, limit etc.)"),
      body: z.any().optional().describe("Corpo JSON para POST"),
      token_kind: z.enum(["user", "page"]).default("user"),
      page_id: z.string().optional(),
      paginate: z.boolean().default(false).describe("Seguir paging.next (só GET de listas)"),
      version: z.string().optional().describe(`Padrão ${DEFAULT_VERSION}`),
      profile: profileArg,
    },
  },
  safe(async ({ method, path, params, body, token_kind, page_id, paginate, version, profile }) => {
    const token = token_kind === "page" ? await pageToken(pageId(page_id, profile), profile) : undefined;
    const opts = { method, path, params, body, profile, token, version };
    return paginate && method === "GET" ? graphAll(opts) : graph(opts);
  })
);

// ---------- Conta ----------

server.registerTool(
  "ig_accounts",
  {
    description: "Lista suas Páginas do Facebook e a conta do Instagram profissional ligada a cada uma.",
    inputSchema: { profile: profileArg },
  },
  safe(({ profile }) =>
    graphAll({
      path: "me/accounts",
      params: { fields: "id,name,instagram_business_account{id,username,name,followers_count,follows_count,media_count}", limit: 100 },
      profile,
    })
  )
);

server.registerTool(
  "ig_profile",
  {
    description: "Dados do seu perfil do Instagram: nome, bio, seguidores, seguindo, número de posts, site.",
    inputSchema: { ig_user_id: igArg, profile: profileArg },
  },
  safe(({ ig_user_id, profile }) =>
    graph({
      path: igId(ig_user_id, profile),
      params: { fields: "id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url" },
      profile,
    })
  )
);

server.registerTool(
  "ig_media",
  {
    description: "Lista seus posts mais recentes (legenda, tipo, data, curtidas, comentários, link).",
    inputSchema: { limit: z.number().int().min(1).max(500).default(25), ig_user_id: igArg, profile: profileArg },
  },
  safe(({ limit, ig_user_id, profile }) =>
    graphAll(
      {
        path: `${igId(ig_user_id, profile)}/media`,
        params: {
          fields: "id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,media_url,thumbnail_url",
          limit: Math.min(limit, 100),
        },
        profile,
      },
      limit
    )
  )
);

// ---------- Números ----------

server.registerTool(
  "ig_account_insights",
  {
    description:
      "Números da conta num período: alcance, visualizações, contas engajadas, interações, curtidas, comentários, compartilhamentos, salvamentos, seguidores ganhos/perdidos, cliques no link. " +
      "since/until em AAAA-MM-DD (máximo 30 dias por consulta). Omitido = últimos 7 dias.",
    inputSchema: {
      metrics: z
        .array(z.string())
        .default(["reach", "views", "accounts_engaged", "total_interactions", "likes", "comments", "shares", "saves", "follows_and_unfollows", "profile_links_taps"]),
      since: z.string().optional(),
      until: z.string().optional(),
      breakdown: z.string().optional().describe("Ex.: 'media_product_type' ou 'follow_type'"),
      ig_user_id: igArg,
      profile: profileArg,
    },
  },
  safe(({ metrics, since, until, breakdown, ig_user_id, profile }) => {
    const toUnix = (d) => Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000);
    const now = Math.floor(Date.now() / 1000);
    return graph({
      path: `${igId(ig_user_id, profile)}/insights`,
      params: {
        metric: metrics.join(","),
        period: "day",
        metric_type: "total_value",
        since: since ? toUnix(since) : now - 7 * 86400,
        until: until ? toUnix(until) : now,
        breakdown,
      },
      profile,
    });
  })
);

server.registerTool(
  "ig_followers_history",
  {
    description: "Seguidores novos por dia nos últimos 30 dias (só contas com 100+ seguidores).",
    inputSchema: { ig_user_id: igArg, profile: profileArg },
  },
  safe(({ ig_user_id, profile }) => {
    const now = Math.floor(Date.now() / 1000);
    return graph({
      path: `${igId(ig_user_id, profile)}/insights`,
      params: { metric: "follower_count", period: "day", since: now - 29 * 86400, until: now },
      profile,
    });
  })
);

server.registerTool(
  "ig_media_insights",
  {
    description: "Números de um post específico: visualizações, alcance, curtidas, comentários, compartilhamentos, salvamentos, interações.",
    inputSchema: {
      media_id: z.string(),
      metrics: z.array(z.string()).default(["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"]),
      profile: profileArg,
    },
  },
  safe(({ media_id, metrics, profile }) => graph({ path: `${media_id}/insights`, params: { metric: metrics.join(",") }, profile }))
);

server.registerTool(
  "ig_business_discovery",
  {
    description:
      "Analisa outro perfil profissional do Instagram (concorrente, referência, marca) pelo @: bio, seguidores e os últimos posts com curtidas e comentários. Não funciona com contas pessoais.",
    inputSchema: {
      username: z.string().describe("Sem @"),
      media_limit: z.number().int().min(0).max(100).default(25),
      ig_user_id: igArg,
      profile: profileArg,
    },
  },
  safe(({ username, media_limit, ig_user_id, profile }) => {
    const media = media_limit
      ? `,media.limit(${media_limit}){id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count}`
      : "";
    return graph({
      path: igId(ig_user_id, profile),
      params: {
        fields: `business_discovery.username(${username.replace(/^@/, "")}){id,username,name,biography,website,followers_count,follows_count,media_count${media}}`,
      },
      profile,
    });
  })
);

// ---------- Publicação ----------

async function waitContainer(id, profile) {
  // Vídeo e reel precisam ser processados pela Meta antes de publicar.
  for (let i = 0; i < 60; i++) {
    const r = await graph({ path: id, params: { fields: "status_code,status" }, profile });
    if (!r.ok) throw new Error(metaError(r.data, "Não consegui ver o status da mídia"));
    if (r.data.status_code === "FINISHED") return;
    if (r.data.status_code === "ERROR" || r.data.status_code === "EXPIRED")
      throw new Error(`A Meta não conseguiu processar a mídia: ${r.data.status || r.data.status_code}`);
    await sleep(5000);
  }
  throw new Error("A mídia demorou mais de 5 minutos para processar. Tente de novo mais tarde.");
}

async function createContainer(ig, params, profile) {
  const r = await graph({ method: "POST", path: `${ig}/media`, params, profile });
  if (!r.ok) throw new Error(metaError(r.data, "A Meta recusou a mídia"));
  return r.data.id;
}

server.registerTool(
  "ig_publish",
  {
    description:
      "Publica no Instagram: foto, carrossel (2 a 10 itens), reel ou story. As mídias precisam estar num link público (https) que a Meta consiga baixar; JPEG para foto, MP4 para vídeo. " +
      "Publica DE VERDADE no perfil: mostre legenda e mídias ao usuário e só chame depois que ele confirmar.",
    inputSchema: {
      type: z.enum(["image", "carousel", "reel", "story"]),
      caption: z.string().optional(),
      image_url: z.string().url().optional().describe("Foto ou story de imagem"),
      video_url: z.string().url().optional().describe("Reel ou story de vídeo"),
      items: z
        .array(z.object({ image_url: z.string().url().optional(), video_url: z.string().url().optional() }))
        .optional()
        .describe("Itens do carrossel, na ordem"),
      cover_url: z.string().url().optional().describe("Capa do reel"),
      share_to_feed: z.boolean().default(true).describe("Reel também aparece no feed"),
      ig_user_id: igArg,
      profile: profileArg,
    },
  },
  safe(async ({ type, caption, image_url, video_url, items, cover_url, share_to_feed, ig_user_id, profile }) => {
    const ig = igId(ig_user_id, profile);
    let creation;
    if (type === "image") {
      if (!image_url) throw new Error("Foto precisa de image_url.");
      creation = await createContainer(ig, { image_url, caption }, profile);
    } else if (type === "reel") {
      if (!video_url) throw new Error("Reel precisa de video_url.");
      creation = await createContainer(ig, { media_type: "REELS", video_url, caption, cover_url, share_to_feed }, profile);
    } else if (type === "story") {
      if (!image_url && !video_url) throw new Error("Story precisa de image_url ou video_url.");
      creation = await createContainer(ig, { media_type: "STORIES", image_url, video_url }, profile);
    } else {
      if (!items || items.length < 2 || items.length > 10) throw new Error("Carrossel precisa de 2 a 10 itens.");
      const children = [];
      for (const it of items) {
        const params = it.video_url
          ? { media_type: "VIDEO", video_url: it.video_url, is_carousel_item: true }
          : { image_url: it.image_url, is_carousel_item: true };
        const id = await createContainer(ig, params, profile);
        if (it.video_url) await waitContainer(id, profile);
        children.push(id);
      }
      creation = await createContainer(ig, { media_type: "CAROUSEL", children: children.join(","), caption }, profile);
    }
    await waitContainer(creation, profile);
    const pub = await graph({ method: "POST", path: `${ig}/media_publish`, params: { creation_id: creation }, profile });
    if (!pub.ok) throw new Error(metaError(pub.data, "A Meta recusou a publicação"));
    const info = await graph({ path: pub.data.id, params: { fields: "id,permalink,timestamp" }, profile });
    return { ok: true, published: info.ok ? info.data : pub.data };
  })
);

server.registerTool(
  "ig_publishing_limit",
  {
    description: "Quantas publicações você ainda pode fazer nas próximas 24 horas (a Meta limita a 100 posts por dia via API).",
    inputSchema: { ig_user_id: igArg, profile: profileArg },
  },
  safe(({ ig_user_id, profile }) =>
    graph({ path: `${igId(ig_user_id, profile)}/content_publishing_limit`, params: { fields: "config,quota_usage" }, profile })
  )
);

// ---------- Comentários ----------

server.registerTool(
  "ig_comments",
  {
    description: "Lista os comentários de um post, com as respostas.",
    inputSchema: { media_id: z.string(), limit: z.number().int().min(1).max(500).default(50), profile: profileArg },
  },
  safe(({ media_id, limit, profile }) =>
    graphAll(
      {
        path: `${media_id}/comments`,
        params: { fields: "id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp}", limit: Math.min(limit, 100) },
        profile,
      },
      limit
    )
  )
);

server.registerTool(
  "ig_comment_reply",
  {
    description: "Responde publicamente a um comentário. Aparece no post: confirme o texto com o usuário antes.",
    inputSchema: { comment_id: z.string(), message: z.string(), profile: profileArg },
  },
  safe(({ comment_id, message, profile }) => graph({ method: "POST", path: `${comment_id}/replies`, params: { message }, profile }))
);

server.registerTool(
  "ig_comment_moderate",
  {
    description: "Esconde, mostra ou apaga um comentário. Apagar não tem volta: confirme antes.",
    inputSchema: { comment_id: z.string(), action: z.enum(["hide", "unhide", "delete"]), profile: profileArg },
  },
  safe(({ comment_id, action, profile }) =>
    action === "delete"
      ? graph({ method: "DELETE", path: comment_id, profile })
      : graph({ method: "POST", path: comment_id, params: { hide: action === "hide" }, profile })
  )
);

// ---------- Direct ----------

server.registerTool(
  "ig_private_reply",
  {
    description:
      "Manda uma mensagem no Direct para quem comentou (resposta privada a um comentário, o mesmo que o ManyChat faz). Uma por comentário, até 7 dias depois. " +
      "Para pessoas sem função no seu app, só funciona com o app aprovado na Meta (Acesso Avançado). Mensagem real: confirme antes.",
    inputSchema: { comment_id: z.string(), text: z.string(), page_id: z.string().optional(), profile: profileArg },
  },
  safe(async ({ comment_id, text, page_id, profile }) =>
    graph({
      method: "POST",
      path: `${pageId(page_id, profile)}/messages`,
      body: { recipient: { comment_id }, message: { text } },
      token: await pageToken(pageId(page_id, profile), profile),
    })
  )
);

server.registerTool(
  "ig_conversations",
  {
    description:
      "Lista as conversas do Direct, com as últimas mensagens. Sem o app aprovado (Acesso Avançado), a Meta só mostra conversas com contas que têm função no app.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20), page_id: z.string().optional(), profile: profileArg },
  },
  safe(async ({ limit, page_id, profile }) => {
    const pg = pageId(page_id, profile);
    return graph({
      path: `${pg}/conversations`,
      params: { platform: "instagram", fields: "id,updated_time,participants,messages.limit(5){id,from,to,message,created_time}", limit },
      token: await pageToken(pg, profile),
    });
  })
);

server.registerTool(
  "ig_send",
  {
    description:
      "Envia uma mensagem no Direct. recipient_id é o ID da pessoa no Instagram (vem de ig_conversations). " +
      "Só funciona até 24 horas depois da última mensagem dela. Mensagem real: confirme antes.",
    inputSchema: {
      recipient_id: z.string(),
      text: z.string().optional(),
      raw_message: z.any().optional().describe("Objeto 'message' completo (anexos, respostas rápidas)"),
      page_id: z.string().optional(),
      profile: profileArg,
    },
  },
  safe(async ({ recipient_id, text, raw_message, page_id, profile }) => {
    const pg = pageId(page_id, profile);
    return graph({
      method: "POST",
      path: `${pg}/messages`,
      body: { recipient: { id: recipient_id }, message: raw_message || { text } },
      token: await pageToken(pg, profile),
    });
  })
);

await server.connect(new StdioServerTransport());
