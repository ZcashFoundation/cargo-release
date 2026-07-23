import type {
  GithubRelease,
  ReleasePackage,
  ReleasePlan,
} from "./release-plan.js";

export type {
  GithubRelease,
  ReleasePackage,
  ReleasePlan,
} from "./release-plan.js";

export type Phase = "check" | "publish" | "finalize" | "all";

export type ObservationState =
  "matching" | "missing" | "repairable" | "conflicting" | "transient";

export interface Observation {
  state: ObservationState;
  subject: string;
  detail?: string;
}

export interface ReconcilePorts {
  observePackage(item: ReleasePackage): Promise<Observation>;
  dryRunPackages(items: readonly ReleasePackage[]): Promise<void>;
  publishPackages(items: readonly ReleasePackage[]): Promise<void>;
  observeTag(item: ReleasePackage): Promise<Observation>;
  createTag(item: ReleasePackage): Promise<void>;
  observeGithubRelease(
    release: GithubRelease,
  ): Promise<Observation | undefined>;
  createGithubRelease(release: GithubRelease): Promise<void>;
  updateGithubRelease(release: GithubRelease): Promise<void>;
  wait(): Promise<void>;
}

export interface ReconcileOptions {
  attempts: number;
}

export interface CompleteReport {
  state: "complete";
  packages: Observation[];
  tags: Observation[];
  githubRelease?: Observation;
}

export interface FailedReport {
  state: "failed";
  reason: "conflict" | "transient" | "incomplete";
  retryable: boolean;
  operationError?: string;
  packages: Observation[];
  tags: Observation[];
  githubRelease?: Observation;
}

export type ReconcileReport = CompleteReport | FailedReport;

function complete(
  packages: Observation[],
  tags: Observation[],
  githubRelease?: Observation,
): CompleteReport {
  return githubRelease
    ? { state: "complete", packages, tags, githubRelease }
    : { state: "complete", packages, tags };
}

function failure(
  reason: FailedReport["reason"],
  packages: Observation[],
  tags: Observation[] = [],
  githubRelease?: Observation,
): FailedReport {
  const report = {
    state: "failed" as const,
    reason,
    retryable: reason === "transient" || reason === "incomplete",
    packages,
    tags,
  };

  return githubRelease ? { ...report, githubRelease } : report;
}

function contains(
  observations: Observation[],
  state: ObservationState,
): boolean {
  return observations.some((observation) => observation.state === state);
}

function missingPackages(
  plan: ReleasePlan,
  observations: Observation[],
): ReleasePackage[] {
  return plan.packages.filter(
    (_, index) => observations[index]?.state === "missing",
  );
}

function inspectionFailure(
  packages: Observation[],
  tags: Observation[] = [],
  githubRelease?: Observation,
): FailedReport | undefined {
  const observations = githubRelease
    ? [...packages, ...tags, githubRelease]
    : [...packages, ...tags];

  if (contains(observations, "conflicting"))
    return failure("conflict", packages, tags, githubRelease);
  if (contains(observations, "transient"))
    return failure("transient", packages, tags, githubRelease);
  if (contains(packages, "repairable") || contains(tags, "repairable")) {
    return failure("conflict", packages, tags, githubRelease);
  }
  return undefined;
}

async function observePackages(
  plan: ReleasePlan,
  ports: ReconcilePorts,
): Promise<Observation[]> {
  const observations: Observation[] = [];
  for (const item of plan.packages) {
    observations.push(await ports.observePackage(item));
  }
  return observations;
}

async function observeTags(
  plan: ReleasePlan,
  ports: ReconcilePorts,
): Promise<Observation[]> {
  return Promise.all(plan.packages.map((item) => ports.observeTag(item)));
}

async function observeGithubRelease(
  plan: ReleasePlan,
  ports: ReconcilePorts,
): Promise<Observation | undefined> {
  if (!plan.githubRelease) return undefined;

  return (
    (await ports.observeGithubRelease(plan.githubRelease)) ?? {
      state: "missing",
      subject: plan.githubRelease.tag,
    }
  );
}

export async function reconcile(
  plan: ReleasePlan,
  phase: Phase,
  ports: ReconcilePorts,
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  let packages = await observePackages(plan, ports);
  let tags = await observeTags(plan, ports);
  let githubRelease = await observeGithubRelease(plan, ports);
  let attemptedPublication = false;

  const preflightFailure = inspectionFailure(packages, tags, githubRelease);
  if (preflightFailure) return preflightFailure;

  if (phase === "check") {
    if (missingPackages(plan, packages).length > 0) {
      await ports.dryRunPackages(plan.packages);
    }

    if (
      contains(packages, "missing") ||
      contains(tags, "missing") ||
      (githubRelease !== undefined && githubRelease.state !== "matching")
    ) {
      return failure("incomplete", packages, tags, githubRelease);
    }

    return complete(packages, tags, githubRelease);
  }

  if (
    (phase === "publish" || phase === "all") &&
    missingPackages(plan, packages).length > 0
  ) {
    const attempts = Math.max(1, options.attempts);
    await ports.dryRunPackages(plan.packages);
    const missing = missingPackages(plan, packages);
    attemptedPublication = true;
    let publicationError: unknown;
    try {
      await ports.publishPackages(missing);
    } catch (error: unknown) {
      publicationError = error;
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await ports.wait();
      packages = await observePackages(plan, ports);

      if (contains(packages, "conflicting")) {
        return failure("conflict", packages, tags, githubRelease);
      }
      const packageSetIsComplete = packages.every(
        (observation) => observation.state === "matching",
      );
      if (packageSetIsComplete) {
        if (phase === "publish") return complete(packages, tags, githubRelease);
        break;
      }
      if (attempt === attempts - 1) {
        if (contains(packages, "transient")) {
          return failure("transient", packages, tags, githubRelease);
        }
        const report = failure("incomplete", packages, tags, githubRelease);
        return publicationError === undefined
          ? report
          : {
              ...report,
              operationError:
                publicationError instanceof Error
                  ? publicationError.message
                  : String(publicationError),
            };
      }
    }
  }

  if (phase === "publish") return complete(packages, tags, githubRelease);
  if (missingPackages(plan, packages).length > 0)
    return failure("incomplete", packages, tags, githubRelease);

  if (attemptedPublication) {
    // State can change while Cargo publishes, so repeat the read-only checks
    // immediately before finalization begins.
    tags = await observeTags(plan, ports);
    githubRelease = await observeGithubRelease(plan, ports);
    const finalizationFailure = inspectionFailure(
      packages,
      tags,
      githubRelease,
    );
    if (finalizationFailure) return finalizationFailure;
  }

  const missingTagIndexes = plan.packages.flatMap((_, index) =>
    tags[index]?.state === "missing" ? [index] : [],
  );
  for (const index of missingTagIndexes) {
    const item = plan.packages[index];
    if (item === undefined) throw new Error("release plan index is invalid");
    let tagCreationError: unknown;
    try {
      await ports.createTag(item);
    } catch (error: unknown) {
      tagCreationError = error;
    }

    tags[index] = await ports.observeTag(item);
    const afterTagFailure = inspectionFailure(packages, tags, githubRelease);
    if (afterTagFailure) return afterTagFailure;
    if (tags[index]?.state === "missing") {
      if (tagCreationError !== undefined) throw tagCreationError;
      return failure("incomplete", packages, tags, githubRelease);
    }
  }

  if (missingTagIndexes.length > 0) {
    githubRelease = await observeGithubRelease(plan, ports);
    const releaseRaceFailure = inspectionFailure(packages, tags, githubRelease);
    if (releaseRaceFailure) return releaseRaceFailure;
  }

  if (!plan.githubRelease) return complete(packages, tags);

  if (
    githubRelease !== undefined &&
    (githubRelease.state === "missing" || githubRelease.state === "repairable")
  ) {
    let releaseMutationError: unknown;
    try {
      if (githubRelease.state === "missing") {
        await ports.createGithubRelease(plan.githubRelease);
      } else {
        await ports.updateGithubRelease(plan.githubRelease);
      }
    } catch (error: unknown) {
      releaseMutationError = error;
    }

    const observedRelease = await ports.observeGithubRelease(
      plan.githubRelease,
    );
    if (!observedRelease) {
      if (releaseMutationError !== undefined) throw releaseMutationError;
      return failure("incomplete", packages, tags, githubRelease);
    }
    const afterReleaseFailure = inspectionFailure(
      packages,
      tags,
      observedRelease,
    );
    if (afterReleaseFailure)
      return failure(
        afterReleaseFailure.reason,
        packages,
        tags,
        observedRelease,
      );
    if (observedRelease.state !== "matching") {
      if (releaseMutationError !== undefined) throw releaseMutationError;
      return failure("incomplete", packages, tags, observedRelease);
    }
    githubRelease = observedRelease;
  }

  return complete(packages, tags, githubRelease);
}
