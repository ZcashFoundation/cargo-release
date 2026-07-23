import type { ReleasePackage } from "./release-plan.js";

export type Execute = (
  command: string,
  arguments_: string[],
  workingDirectory: string,
) => Promise<number>;

export class CargoPublisher {
  readonly #workingDirectory: string;
  readonly #execute: Execute;

  constructor(workingDirectory: string, execute: Execute) {
    this.#workingDirectory = workingDirectory;
    this.#execute = execute;
  }

  async dryRun(packages: readonly ReleasePackage[]): Promise<void> {
    await this.#publish(packages, true);
  }

  async publish(packages: readonly ReleasePackage[]): Promise<void> {
    await this.#publish(packages, false);
  }

  async #publish(
    packages: readonly ReleasePackage[],
    dryRun: boolean,
  ): Promise<void> {
    if (packages.length === 0) {
      throw new Error("Cargo publication requires at least one package");
    }
    const exitCode = await this.#execute(
      "cargo",
      cargoPublishArguments(packages, dryRun),
      this.#workingDirectory,
    );
    if (exitCode !== 0) {
      throw new Error(`cargo publish failed with exit code ${exitCode}`);
    }
  }
}

function cargoPublishArguments(
  packages: readonly ReleasePackage[],
  dryRun: boolean,
): string[] {
  const arguments_ = ["publish", "--locked"];
  for (const item of packages) {
    arguments_.push("--package", item.name);
  }
  if (dryRun) {
    arguments_.push("--dry-run");
  }
  return arguments_;
}
