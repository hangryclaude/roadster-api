// In-memory fake Tessie server for adapter + agent tests.

import { createServer, type Server } from "node:http";

export function startFakeTessie(): { server: Server; url: string; close(): Promise<void> } {
  const server = createServer((_req, res) => {
    res.writeHead(501).end("fake tessie: not implemented yet");
  });

  server.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
