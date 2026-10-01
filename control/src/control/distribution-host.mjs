import fs from "node:fs";
import { createRadiusScratch } from "../../orca-organization/server/radius-scratch.mjs";
import { createBoundedOutput } from "./bounded-output.mjs";
import path from "node:path";
import { controllerEntry } from "./distribution-files.mjs";
import { spawn } from "node:child_process";
import { readFrames, writeFrames } from "./bounded-pipe.mjs";
import { socketLocation } from "./socket-location.mjs";
import { createTrustedContribution } from "./trusted-contribution.mjs";
import { createChildSupervisor } from "./child-supervisor.mjs";
import { captureOwnedFiles, recoverOwnedFiles } from "./owned-child-files.mjs";
import { parseControllerCommand, READ_METHODS } from "./command-parser.mjs";
import { firstRun } from "../config.mjs";
import { recordBootStart, sealBoot } from "./boot-chain.mjs";
export const hostContract = "1.1";
export default function setup() {
  throw Error("Distribution startup context required");
}
export function createDistribution({ home, bundleDirectory }) {
  firstRun({ ORCA_HOME: home });
  let supervisor, mint, authority, intercomRateSettingsFile;
  const epochs = new WeakMap(),
    owners = new WeakMap(),
    channels = new WeakMap();
  return {
    reportGrantDirectory: path.join(home, "grants", "report"),
    simulateRadiusScratch(input, assertCurrentOwner, assertCurrentPruneOwner) {
      assertCurrentOwner();
      const result = createRadiusScratch({
        root: path.join(home, "radius-scratch"),
        assertCurrentOwner,
        assertCurrentPruneOwner,
      }).simulate(input);
      assertCurrentOwner();
      return result;
    },
    setup(server) {
      mint = (binding) => server.issueProvenance(binding);
      createTrustedContribution({
        home,
        rateSettingsFile: () => intercomRateSettingsFile,
        managementBridge: async (command, principal) => {
          if (!supervisor) throw Error("Controller not ready");
          if (["controller-status", "controller-retry"].includes(command.method)) {
            authority(command, principal);
            return command.method === "controller-retry" ? supervisor.retry() : supervisor.status;
          }
          return supervisor.management(command, principal);
        },
      })(server);
    },
    validate: parseControllerCommand,
    // D13: the host runs only these for a read-only device (its read-only management invocation).
    isRead: (command) => READ_METHODS.includes(command?.method),
    get ready() {
      return supervisor?.ready === true;
    },
    start(host) {
      intercomRateSettingsFile = host.intercomRateSettingsFile;
      authority = host.consumeManagement;
      if (supervisor || !mint) throw Error("Invalid controller startup order");
      // W1 row 9: this boot's record, before the controller (and its seat sweep) starts. Without it the sweep declines.
      // A pre-W1 host passes no previousBoot (undefined): recordBootStart then voids every seal first (review W1-1(b)).
      try {
        recordBootStart(home, host.boot, host.previousBoot);
      } catch (e) {
        console.error("Orca boot record:", e.message);
      }
      supervisor = createChildSupervisor({
        boot: host.boot,
        spawn() {
          // Explicit allowlist: no daemon password, NODE_PATH, preload or caller startup options.
          const child = spawn(process.execPath, [controllerEntry(bundleDirectory)], {
            cwd: bundleDirectory,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              TMPDIR: process.env.TMPDIR,
              ORCA_HOME: home,
              ...(host.intercomRateSettingsFile
                ? { PASEO_INTERCOM_RATE_FILE: host.intercomRateSettingsFile }
                : {}),
              ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
            },
            stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"],
          });
          const fail = (error) => {
            console.error(
              "Controller pipe closed:",
              error?.message ?? "closed or capacity exceeded",
            );
            child.emit("disconnect");
            child.kill("SIGTERM");
          };
          child.connected = true;
          child.once("exit", () => {
            child.connected = false;
          });
          child.send = writeFrames(child.stdio[3], {
            maxBytes: 8 * 1024 * 1024,
            maxQueuedBytes: 8 * 1024 * 1024,
            onError: fail,
            beforeWrite: (frame) => channels.get(child)?.checkPublication?.(frame),
          });
          child.stdio[3].on("error", fail);
          readFrames(child.stdio[4], {
            maxBytes: 1024 * 1024,
            onFrame: (frame) => child.emit("message", frame),
            onError: fail,
          });
          return child;
        },
        createChannel(child, send) {
          let channel;
          const output = createBoundedOutput({
            send: (frame, done) => child.send(frame, done),
            fail: () => {
              console.error("Controller host output closed or capacity exceeded");
              channel?.close();
              child.kill("SIGTERM");
            },
          });
          channel = host.createChannel(
            child,
            send,
            (frame) => {
              if (child.connected) output(frame);
            },
            mint,
          );
          channels.set(child, channel);
          epochs.set(child, channel.epoch);
          return channel;
        },
        onReady(child, channel) {
          owners.set(child, captureOwnedFiles(home, { pid: child.pid, epoch: channel.epoch }));
        },
        recover(child) {
          let owner = owners.get(child);
          if (!owner && fs.existsSync(path.join(home, "process.lock")))
            owner = captureOwnedFiles(home, { pid: child.pid, epoch: epochs.get(child) });
          if (owner) recoverOwnedFiles(owner, { exited: true });
          else if (fs.existsSync(socketLocation(home).socket))
            throw Error("Unowned controller socket");
        },
      });
      supervisor.start();
    },
    async stop() {
      await supervisor?.stop();
    },
    // Called by the daemon only at the end of its orderly shutdown, just before its trusted host closes.
    sealBoot({ boot, humanAt }) {
      sealBoot(home, boot, humanAt);
    },
  };
}
