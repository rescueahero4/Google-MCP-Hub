// Google MCP Hub: one node:http server, no framework.

import { createServer } from "node:http";
import { config } from "./config.ts";
import { HttpError, json } from "./http.ts";
import { handleMcp } from "./mcp.ts";
import { approve, authenticate, authorizationServerMetadata, authorize, protectedResourceMetadata, register, token } from "./oauth.ts";
import { connect, disconnect, googleCallback, home, login, logout, update } from "./web.ts";

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", config.baseUrl);
  const route = `${req.method} ${url.pathname}`;
  try {
    switch (route) {
      case "GET /.well-known/oauth-protected-resource":
      case "GET /.well-known/oauth-protected-resource/mcp":
        return protectedResourceMetadata(res);
      case "GET /.well-known/oauth-authorization-server":
        return authorizationServerMetadata(res);
      case "POST /register":
        return await register(req, res);
      case "GET /authorize":
        return authorize(url, res);
      case "POST /authorize/approve":
        return await approve(req, res);
      case "POST /token":
        return await token(req, res);
      case "GET /oauth/google/callback":
        return await googleCallback(req, res, url);
      case "GET /login":
        return login(url, res);
      case "GET /logout":
        return logout(res);
      case "GET /":
        return await home(req, res, url);
      case "GET /connect":
        return await connect(req, res, url);
      case "POST /accounts/update":
        return await update(req, res, url);
      case "POST /accounts/disconnect":
        return await disconnect(req, res, url);
      // Not /healthz: Cloud Run's front end reserves paths ending in "z".
      case "GET /health":
        return json(res, 200, { ok: true });
    }
    if (url.pathname === "/mcp") {
      const user = authenticate(req, res);
      if (user) await handleMcp(req, res, user);
      return;
    }
    json(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof HttpError) return json(res, error.status, { error: error.message });
    console.error(JSON.stringify({ severity: "ERROR", message: `${route} failed`, error: String(error) }));
    if (!res.headersSent) json(res, 500, { error: "internal_error" });
  }
});

server.listen(config.port, () => {
  console.log(JSON.stringify({ severity: "INFO", message: `Google MCP Hub listening on ${config.port}`, baseUrl: config.baseUrl, store: config.store }));
});
