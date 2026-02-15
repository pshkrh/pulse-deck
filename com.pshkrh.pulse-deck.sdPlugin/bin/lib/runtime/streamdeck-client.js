"use strict";

let WebSocketImpl = globalThis.WebSocket;
if (!WebSocketImpl) {
  try {
    // Node runtime inside Stream Deck does not expose a global WebSocket.
    // eslint-disable-next-line global-require
    WebSocketImpl = require("ws");
  } catch {
    WebSocketImpl = null;
  }
}

function parseLaunchArguments(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key || !key.startsWith("-")) {
      continue;
    }

    const value = argv[index + 1];
    args[key.slice(1)] = value;
  }
  return args;
}

function bindSocketEvent(socket, name, handler) {
  if (!socket) {
    return;
  }
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(name, handler);
    return;
  }
  if (typeof socket.on === "function") {
    socket.on(name, handler);
  }
}

function parseSocketMessage(rawPayload) {
  if (rawPayload === undefined || rawPayload === null) {
    return null;
  }

  if (typeof rawPayload === "string") {
    try {
      return JSON.parse(rawPayload);
    } catch {
      return null;
    }
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(rawPayload)) {
    try {
      return JSON.parse(rawPayload.toString("utf8"));
    } catch {
      return null;
    }
  }

  if (typeof rawPayload === "object" && rawPayload.data !== undefined) {
    return parseSocketMessage(rawPayload.data);
  }

  return null;
}

function createStreamDeckClient(options = {}) {
  const pluginLabel = options.pluginLabel || "Pulse Deck";

  let socket = null;
  let pluginUUID = "";
  let registerEvent = "registerPlugin";
  const handlers = new Set();

  function send(message) {
    if (!socket) {
      return;
    }

    const readyStateOpen = typeof socket.OPEN === "number" ? socket.OPEN : 1;
    if (socket.readyState !== readyStateOpen) {
      return;
    }

    socket.send(JSON.stringify(message));
  }

  return {
    connect() {
      const launchArgs = parseLaunchArguments(process.argv.slice(2));
      const port = launchArgs.port;
      pluginUUID = launchArgs.pluginUUID || "";
      registerEvent = launchArgs.registerEvent || "registerPlugin";

      if (!port) {
        throw new Error("Stream Deck did not provide the websocket port.");
      }

      if (!WebSocketImpl) {
        throw new Error("WebSocket implementation not available. Install dependency 'ws'.");
      }

      socket = new WebSocketImpl(`ws://127.0.0.1:${port}`);

      bindSocketEvent(socket, "open", () => {
        send({
          event: registerEvent,
          uuid: pluginUUID,
        });
      });

      bindSocketEvent(socket, "message", (eventPayload) => {
        const message = parseSocketMessage(eventPayload);
        if (!message) {
          return;
        }

        for (const handler of handlers) {
          handler(message);
        }
      });

      bindSocketEvent(socket, "error", () => {
        // Stream Deck host controls restart behavior.
      });
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    setImage(context, imageDataUrl) {
      for (const target of [0, 1]) {
        send({
          event: "setImage",
          context,
          payload: {
            image: imageDataUrl,
            target,
            state: 0,
          },
        });
      }
    },
    setTitle(context, title) {
      send({
        event: "setTitle",
        context,
        payload: {
          title: title || "",
          target: 0,
          state: 0,
        },
      });
    },
    showAlert(context) {
      send({
        event: "showAlert",
        context,
      });
    },
    logMessage(message) {
      send({
        event: "logMessage",
        payload: {
          message: `[${pluginLabel}] ${message}`,
        },
      });
    },
  };
}

module.exports = {
  createStreamDeckClient,
  parseLaunchArguments,
  parseSocketMessage,
};
