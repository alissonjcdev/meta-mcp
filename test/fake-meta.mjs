// Graph API falsa para testar o setup sem tocar em conta real.
globalThis.fetch = async (input) => {
  const u = new URL(String(input));
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  const p = u.pathname.replace(/^\/v\d+\.\d+\//, "");
  if (p === "debug_token") {
    const long = u.searchParams.get("input_token") === "EAALONGTOKEN0000000000000000";
    return json({ data: { is_valid: true, app_id: "1234567890", expires_at: long ? 1893456000 : 1790000000, scopes: ["instagram_basic", "pages_show_list"] } });
  }
  if (p === "oauth/access_token") return json({ access_token: "EAALONGTOKEN0000000000000000", expires_in: 5184000 });
  if (p === "me/accounts")
    return json({ data: [{ id: "111", name: "Página Teste", instagram_business_account: { id: "999", username: "cafeteria.teste", followers_count: 10 } }] });
  return json({ error: { message: `rota não simulada: ${p}` } }, 400);
};
