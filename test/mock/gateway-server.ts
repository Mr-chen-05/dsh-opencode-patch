/**
 * Boot the mock gateway on a real Vite server, for the mock suite.
 *
 * `vite-plus` re-exports Vite, so this is Vite's own middleware-mode recipe:
 * the plugin from `opencode-gateway.ts` is installed on a dev server whose
 * middleware stack is handed to a `node:http` listener bound to an ephemeral
 * port. Nothing is served from disk, so the root is the mock directory itself
 * and `configFile: false` keeps the repository's own `vite.config.ts` — and
 * its test block — out of the boot.
 *
 * @module dsh-opencode-patch/mock-gateway-server
 */

import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";

import { createServer as createViteServer } from "vite-plus";

import {
  openCodeGateway,
  type GatewayRequest,
  type OpenCodeGatewayOptions,
} from "./opencode-gateway.ts";

export interface MockGateway {
  /** Every request the gateway saw, in order. */
  readonly requests: GatewayRequest[];
  /** The origin to send requests to, e.g. `http://127.0.0.1:49152`. */
  readonly origin: string;
  /** Stop the listener and the Vite server behind it. */
  readonly close: () => Promise<void>;
}

export const startMockGateway = async (
  options: OpenCodeGatewayOptions = {}
): Promise<MockGateway> => {
  const requests: GatewayRequest[] = [];
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    plugins: [
      openCodeGateway({
        ...options,
        onRequest: (request) => {
          requests.push(request);
        },
      }),
    ],
    root: fileURLToPath(new URL(".", import.meta.url)),
    server: { hmr: false, middlewareMode: true, watch: null },
  });
  const http = createHttpServer((request, response) => {
    vite.middlewares(request, response);
  });
  await new Promise<void>((resolve) => {
    http.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = http.address();
  if (address === null || typeof address === "string") {
    throw new Error("the mock gateway did not bind a TCP port");
  }
  return {
    close: async () => {
      await vite.close();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
    origin: `http://127.0.0.1:${address.port}`,
    requests,
  };
};
