import { describe, expect, test, vi } from "vitest";

import { CargoPublisher } from "./cargo-publisher.js";
import type { ReleasePackage } from "./reconcile.js";

const packages: ReleasePackage[] = [
  {
    name: "example-core",
    version: "1.0.0",
    manifestPath: "crates/example-core/Cargo.toml",
    tag: "example-core-v1.0.0",
  },
  {
    name: "example-cli",
    version: "1.0.0",
    manifestPath: "crates/example-cli/Cargo.toml",
    tag: "example-cli-v1.0.0",
  },
];

describe("CargoPublisher", () => {
  test("delegates one complete dry-run plan to Cargo", async () => {
    const execute = vi.fn(async () => 0);
    const publisher = new CargoPublisher("/workspace", execute);

    await publisher.dryRun(packages);

    expect(execute).toHaveBeenCalledWith(
      "cargo",
      [
        "publish",
        "--locked",
        "--package",
        "example-core",
        "--package",
        "example-cli",
        "--dry-run",
      ],
      "/workspace",
    );
  });

  test("publishes exactly the current missing package set in one Cargo plan", async () => {
    const execute = vi.fn(async () => 0);
    const publisher = new CargoPublisher("/workspace", execute);

    await publisher.publish([packages[1]!]);

    expect(execute).toHaveBeenCalledWith(
      "cargo",
      ["publish", "--locked", "--package", "example-cli"],
      "/workspace",
    );
  });

  test("fails when Cargo rejects a plan", async () => {
    const publisher = new CargoPublisher("/workspace", async () => 101);

    await expect(publisher.dryRun(packages)).rejects.toThrow(
      "cargo publish failed with exit code 101",
    );
  });

  test("refuses an empty package set instead of publishing the current package", async () => {
    const execute = vi.fn(async () => 0);
    const publisher = new CargoPublisher("/workspace", execute);

    await expect(publisher.publish([])).rejects.toThrow(
      "Cargo publication requires at least one package",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
