# meta-mcp

Conecte o Claude ao seu Instagram pela API oficial da Meta.

Depois de instalado, você conversa com o Claude e ele mexe no seu perfil por você: puxa os números, analisa outros perfis, publica e cuida dos comentários. Sem app de terceiro pedindo a sua senha.

## O que dá pra fazer

- **Seus números, na hora:** alcance, visualizações, interações, seguidores ganhos, desempenho de cada post.
- **Estudar o mercado:** analisar qualquer perfil profissional (concorrente, referência, marca) com os últimos posts e o engajamento de cada um.
- **Publicar:** foto, carrossel, reel e story, com legenda.
- **Comentários:** ler, responder, esconder e apagar.
- **Direct:** ler conversas, responder e mandar mensagem para quem comentou (veja a ressalva abaixo).
- **E o resto da API:** a ferramenta `graph_request` chama qualquer endpoint da Graph API.

## Antes de começar

- Instagram **profissional** (Criador ou Empresa) ligado a uma **Página do Facebook**.
- [Node.js](https://nodejs.org) 20 ou mais novo.
- [Claude Desktop](https://claude.ai/download) (ou Claude Code).
- Um app no [painel de desenvolvedores da Meta](https://developers.facebook.com/apps), com o caso de uso do Instagram na opção **"API com Login do Facebook"**.

## Instalação em 3 passos

**1. Gere um token** no [Explorador da Graph API](https://developers.facebook.com/tools/explorer): escolha o seu app, clique em **Gerar token de acesso** e marque estas permissões:

```
instagram_basic
instagram_manage_insights
instagram_content_publish
instagram_manage_comments
instagram_manage_messages
pages_show_list
pages_read_engagement
business_management
```

**2. Rode o setup** no terminal:

```
npx -y github:alissonjcdev/meta-mcp setup
```

Ele pede o App ID, a chave secreta do app e o token. Depois troca o token por um que vale 60 dias, acha a sua conta do Instagram e já configura o Claude Desktop (guardando uma cópia do arquivo que existia antes).

**3. Feche e abra o Claude Desktop.** Peça: *"Como foi meu Instagram nos últimos 7 dias?"*

Para usar no Claude Code, o setup também mostra o comando `claude mcp add` pronto para copiar.

## Comandos

| comando | o que faz |
|---|---|
| `meta-mcp setup` | conecta a conta e configura o Claude Desktop |
| `meta-mcp check` | mostra se o token está válido e até quando |
| `meta-mcp renew` | troca por um token novo quando o atual vencer (a cada ~60 dias) |

Use `npx -y github:alissonjcdev/meta-mcp <comando>` se não tiver instalado.

## Onde ficam os seus dados

Tudo fica só no seu computador, em `~/.meta-mcp/config.json` (no Windows, `%USERPROFILE%\.meta-mcp\config.json`), com acesso restrito ao seu usuário. Nada passa por servidor nosso. Para servidores, você pode usar variáveis de ambiente no lugar do arquivo: `META_ACCESS_TOKEN`, `META_APP_ID`, `META_APP_SECRET`, `META_IG_USER_ID` e `META_PAGE_ID`.

## Ressalva honesta sobre o Direct

Enquanto o seu app está em **modo de desenvolvimento** (o padrão), a Meta só deixa ler e mandar Direct para contas que têm função no app (você e quem você adicionar como testador). Para responder qualquer pessoa, inclusive com o "comentário vira DM", o app precisa passar pela **Análise do App** da Meta e ganhar **Acesso Avançado** a `instagram_manage_messages`. O resto (números, análise de perfis, publicação, comentários) funciona na sua própria conta sem análise.

Publicar, responder e mandar mensagem são ações reais. O Claude deve sempre te mostrar o que vai fazer e esperar a sua confirmação.

## Licença

MIT. Feito por [Alisson Chaves](https://alissondsgn.com.br) com o MCP SDK oficial da Anthropic.
