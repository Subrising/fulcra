import { rotateOfflineRelayIdentity, revokeOfflineDevice } from "@getpaseo/server/pairing";
import { readDaemonInstance } from "@getpaseo/server/daemon-control";
import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import {
  addJsonAndDaemonHostOptions,
  addLocalDaemonOptions,
  withGlobalOptions,
} from "../../utils/command-options.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";
export function devicesCommand(): Command {
  const command = new Command("devices").description("List or remove paired devices from this Mac");
  addJsonAndDaemonHostOptions(command.command("list")).action(
    withGlobalOptions(async (options: { daemonTarget: DaemonTarget }, _command: Command) => {
      const client = await connectToDaemon({ target: options.daemonTarget });
      try {
        process.stdout.write(JSON.stringify(await client.listPairedDevices(), null, 2) + "\n");
      } finally {
        await client.close();
      }
    }),
  );
  addJsonAndDaemonHostOptions(
    command
      .command("revoke <deviceId>")
      .option("--offline", "Revoke in a stopped local daemon home"),
  ).action(
    withGlobalOptions(
      async (
        deviceId: string,
        options: { daemonTarget: DaemonTarget; offline?: boolean },
        _command: Command,
      ) => {
        if (options.offline) {
          if (options.daemonTarget.kind !== "instance")
            throw new Error("Offline revoke needs a local daemon home");
          await revokeOfflineDevice(options.daemonTarget.home, deviceId);
          process.stdout.write("Device removed from the stopped daemon.\n");
          return;
        }
        const client = await connectToDaemon({ target: options.daemonTarget });
        try {
          await client.revokePairedDevice(deviceId);
          process.stdout.write("Device removed.\n");
        } finally {
          await client.close();
        }
      },
    ),
  );
  return command;
}

export function relayIdentityCommand(): Command {
  const command = new Command("relay").description("Manage the local relay identity");
  addLocalDaemonOptions(
    command.command("rotate").description("Rotate a stopped host identity and unpair every device"),
  ).action(
    withGlobalOptions(async (options: { daemonTarget: DaemonTarget }, _command: Command) => {
      if (options.daemonTarget.kind !== "instance")
        throw new Error("Rotation needs a local daemon home");
      if (await readDaemonInstance(options.daemonTarget.home))
        throw new Error(
          "Stop this daemon before rotating its relay identity; this closes all live device sockets",
        );
      rotateOfflineRelayIdentity(options.daemonTarget.home);
      process.stdout.write(
        "Relay identity rotated. Start the daemon and pair each device again.\n",
      );
    }),
  );
  return command;
}
