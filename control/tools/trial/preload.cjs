// Digest-bound disposable trial injection; never part of Fulcra.app. No live Keychain access.
const Module = require("node:module"),
  fs = require("node:fs"),
  path = require("node:path");
const load = Module._load,
  root = process.env.V4_PROOF_ROOT;
const { rpcResponse } = require("./wire.cjs");
if (!root || !process.env.PASEO_HOME?.startsWith(root + "/"))
  throw Error("Isolated proof home required");
const childProcess = require("node:child_process");
for (const method of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = childProcess[method];
  childProcess[method] = function (file, ...args) {
    if (["security", "launchctl"].includes(String(file).split("/").pop()))
      throw Error("System Keychain/launchd forbidden in staged proof");
    return original.call(this, file, ...args);
  };
}
require("node:module").syncBuiltinESMExports();
const fakeFile = path.join(root, "fake-keychain.json");
Module._load = function (request, parent, isMain) {
  if (request.endsWith("/command-centre-keychain.js") || request === "./command-centre-keychain.js")
    return { commandCentreKeychain: require("./fake-keychain.cjs").createFakeKeychain(root) };
  if (request.endsWith("/device-key-electron.js"))
    return {
      getElectronDeviceKey() {
        throw Error("Device pairing excluded from isolated packaging proof");
      },
    };
  if (request.endsWith("/login-shell-env.js") || request === "./login-shell-env.js")
    return { inheritLoginShellEnv() {} };
  return load.call(this, request, parent, isMain);
};
if (process.env.ELECTRON_RUN_AS_NODE !== "1") {
  const { app, BrowserWindow, nativeTheme } = require("electron");
  app.setAsDefaultProtocolClient = () => false;
  app.setLoginItemSettings = () => {};
  app.setPath("home", path.join(root, "home"));
  app.setPath("userData", path.join(root, "user-data"));
  app.setAppLogsPath(path.join(root, "app-logs"));
  app.whenReady().then(() => {
    const entry = path.join(process.resourcesPath, "app.asar/dist/daemon/daemon-manager.js");
    const handlers = require(entry).createDaemonCommandHandlers();
    let busy = false;
    const observedRpc = [],
      pendingRpc = new Map();
    const observeWindow = (window) => {
      const debug = window.webContents.debugger;
      try {
        debug.attach("1.3");
        void debug.sendCommand("Network.enable");
      } catch {
        return;
      } // No observation means no positive renderer receipt.
      debug.on("message", (_event, method, params) => {
        if (!["Network.webSocketFrameSent", "Network.webSocketFrameReceived"].includes(method))
          return;
        try {
          const raw = params.response?.payloadData;
          if (typeof raw !== "string" || raw.length > 1048576) return;
          const frame = JSON.parse(raw),
            message = frame.message;
          if (
            method === "Network.webSocketFrameSent" &&
            message?.type === "plugin.rpc.invoke.request"
          ) {
            if (pendingRpc.size >= 1024) pendingRpc.delete(pendingRpc.keys().next().value);
            pendingRpc.set(message.requestId, {
              pluginId: message.pluginId,
              method: message.method,
              action: message.input?.action ?? message.input?.command?.action,
            });
          }
          const reply = rpcResponse(frame);
          if (
            method === "Network.webSocketFrameReceived" &&
            reply &&
            pendingRpc.has(reply.requestId)
          ) {
            observedRpc.push({
              ...pendingRpc.get(reply.requestId),
              status: reply.output?.status,
              observedAt: new Date().toISOString(),
            });
            pendingRpc.delete(reply.requestId);
            if (observedRpc.length > 256) observedRpc.shift();
          }
        } catch {} // Never save raw wire bytes or credentials.
      });
    };
    for (const window of BrowserWindow.getAllWindows()) observeWindow(window);
    app.on("browser-window-created", (_event, window) => observeWindow(window));
    setInterval(async () => {
      const file = path.join(root, "command.json");
      if (busy || !fs.existsSync(file)) return;
      busy = true;
      const command = JSON.parse(fs.readFileSync(file));
      fs.unlinkSync(file);
      try {
        let result;
        if (command.name === "quit") {
          fs.writeFileSync(
            path.join(root, "reply.json"),
            JSON.stringify({ id: command.id, ok: true }),
          );
          app.quit();
          return;
        } else if (command.name === "probe") {
          const status = await handlers.desktop_daemon_status();
          const config = JSON.parse(fs.readFileSync(path.join(root, "paseo/config.json")));
          const listen = config.daemon.listen;
          if (
            !/^127\.0\.0\.1:\d+$/.test(listen) ||
            [6767, 6791].includes(Number(listen.split(":")[1]))
          )
            throw Error("Unsafe probe target");
          const WebSocket = require("node:module").createRequire(
            path.join(process.resourcesPath, "app.asar/package.json"),
          )("ws");
          const auth = command.args.auth === true;
          const values = auth ? Object.values(JSON.parse(fs.readFileSync(fakeFile))) : [];
          if (auth && (values.length !== 1 || typeof values[0] !== "string"))
            throw Error("No unique fake credential");
          result = await new Promise((resolve, reject) => {
            const socket = new WebSocket(
              "ws://" + listen + "/ws",
              auth ? { headers: { Authorization: "Bearer " + values[0] } } : {},
            );
            let frames = 0,
              sent = false;
            const requestId = require("node:crypto").randomUUID();
            const timer = setTimeout(() => {
              socket.terminate();
              reject(Error("Probe timeout"));
            }, 15000);
            socket.on("open", () =>
              socket.send(
                JSON.stringify({
                  type: "hello",
                  clientId: requestId,
                  clientType: "cli",
                  protocolVersion: 1,
                  capabilities: { command_centre_permission: true },
                }),
              ),
            );
            socket.on("message", (raw) => {
              frames++;
              if (raw.length > 1048576) {
                socket.terminate();
                return;
              }
              try {
                const value = JSON.parse(raw),
                  message = value.message;
                if (auth && !sent && message?.payload?.status === "server_info") {
                  sent = true;
                  socket.send(
                    JSON.stringify({
                      type: "session",
                      message: {
                        type: "plugin.rpc.invoke.request",
                        requestId,
                        pluginId: "orca-organization-next",
                        method: "organization.manage",
                        input: { action: "health" },
                      },
                    }),
                  );
                }
                const reply = rpcResponse(value);
                if (reply?.requestId === requestId) {
                  clearTimeout(timer);
                  socket.close();
                  resolve({
                    kind: "diagnostic-only",
                    authenticated: true,
                    status: reply.output?.status,
                    daemonPid: status.pid,
                  });
                }
              } catch {}
            });
            socket.on("error", () => {});
            socket.on("close", (code) => {
              clearTimeout(timer);
              if (!auth)
                resolve({
                  kind: "unauthenticated-probe",
                  code,
                  frames,
                  passed: code === 4401 && frames === 0,
                });
              else reject(Error("Authenticated probe closed before result"));
            });
          });
        } else if (command.name.startsWith("ui-")) {
          const window = BrowserWindow.getAllWindows()[0];
          if (!window) throw Error("No staged app window");
          window.show();
          window.focus();
          if (command.name === "ui-navigate") {
            if (!command.args.route.startsWith("/")) throw Error("App route required");
            await window.loadURL("paseo://app" + command.args.route);
          } else if (command.name === "ui-action") {
            const { text, value } = command.args;
            result = await window.webContents.executeJavaScript(
              `(()=>{const text=${JSON.stringify(text)},value=${JSON.stringify(value)};const items=[...document.querySelectorAll('button,a,[role=button],[role=radio],input')];const el=items.find(e=>[e.innerText,e.getAttribute('aria-label'),e.getAttribute('placeholder')].some(label=>(label||'').trim()===text));if(!el)return {found:false};if(value!==undefined){const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));}else el.click();return {found:true};})()`,
            );
          } else if (command.name === "ui-capture") {
            const evidence = path.join(root, "evidence") + path.sep;
            if (!path.resolve(command.args.file).startsWith(evidence))
              throw Error("Capture must remain in job evidence");
            window.setContentSize(1280, 800);
            nativeTheme.themeSource = "light";
            window.webContents.sendInputEvent({ type: "mouseMove", x: 1100, y: 120 });
            await new Promise((resolve) => setTimeout(resolve, 1000));
            fs.writeFileSync(command.args.file, (await window.webContents.capturePage()).toPNG());
          }
          if (!result)
            result = {
              rendererRpc: [...observedRpc],
              url: window.webContents.getURL(),
              visible: window.isVisible(),
              bounds: window.getBounds(),
              frames: await Promise.all(
                window.webContents.mainFrame.framesInSubtree.map(async (frame) => ({
                  url: frame.url,
                  text: await frame
                    .executeJavaScript('document.body?.innerText?.slice(0,18000) ?? ""')
                    .catch(() => ""),
                  controls: await frame
                    .executeJavaScript(
                      '[...document.querySelectorAll("button,a,[role=button],[role=radio],input")].map(e=>({text:(e.innerText||e.getAttribute("aria-label")||e.getAttribute("placeholder")||"").trim().slice(0,150),tag:e.tagName,href:e.getAttribute("href")})).filter(e=>e.text)',
                    )
                    .catch(() => []),
                })),
              ),
            };
        } else if (command.name === "screenshot") {
          const window = BrowserWindow.getAllWindows()[0];
          if (!window) throw Error("No staged app window");
          nativeTheme.themeSource = command.args.theme;
          window.setContentSize(command.args.width, command.args.height);
          await window.loadURL("paseo://app/settings/general");
          await new Promise((resolve) => setTimeout(resolve, 1500));
          fs.writeFileSync(command.args.file, (await window.webContents.capturePage()).toPNG());
          result = { captured: true };
        } else {
          if (
            ![
              "get_desktop_settings",
              "patch_desktop_settings",
              "desktop_daemon_status",
              "stop_desktop_daemon",
              "desktop_bundled_plugin_pins",
              "desktop_daemon_connection_check",
            ].includes(command.name)
          )
            throw Error("Command outside trial scope");
          if (!handlers[command.name]) throw Error("Unknown fixture command");
          result = await handlers[command.name](command.args);
        }
        fs.writeFileSync(
          path.join(root, "reply.json"),
          JSON.stringify({ id: command.id, ok: true, result }),
        );
      } catch (error) {
        fs.writeFileSync(
          path.join(root, "reply.json"),
          JSON.stringify({ id: command.id, ok: false, error: error.message }),
        );
      } finally {
        busy = false;
      }
    }, 100).unref();
    fs.writeFileSync(
      path.join(root, "app-ready.json"),
      JSON.stringify({
        pid: process.pid,
        resources: process.resourcesPath,
        packaged: app.isPackaged,
      }),
    );
  });
}
