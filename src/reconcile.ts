import { asError, errorMessage } from "./errors.js";
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

type StableObservation = Readonly<{
  state: "matching" | "missing";
  subject: string;
  detail?: never;
}>;

type DetailedObservation = Readonly<{
  state: "repairable" | "conflicting" | "transient";
  subject: string;
  detail: string;
}>;

export type Observation = StableObservation | DetailedObservation;
export type ObservationState = Observation["state"];

export interface ReconcilePorts {
  observePackage(item: ReleasePackage): Promise<Observation>;
  dryRunPackages(items: readonly ReleasePackage[]): Promise<void>;
  publishPackages(items: readonly ReleasePackage[]): Promise<void>;
  observeTag(item: ReleasePackage): Promise<Observation>;
  createTag(item: ReleasePackage): Promise<void>;
  observeGithubRelease(release: GithubRelease): Promise<Observation>;
  createGithubRelease(release: GithubRelease): Promise<void>;
  updateGithubRelease(release: GithubRelease): Promise<void>;
  wait(): Promise<void>;
}

export interface ReconcileOptions {
  attempts: number;
}

export interface CompleteReport {
  readonly state: "complete";
  readonly packages: readonly Observation[];
  readonly tags: readonly Observation[];
  readonly githubRelease?: Observation;
}

interface FailedReportBase {
  readonly state: "failed";
  readonly packages: readonly Observation[];
  readonly tags: readonly Observation[];
  readonly githubRelease?: Observation;
}

interface ConflictReport extends FailedReportBase {
  readonly reason: "conflict";
  readonly retryable: false;
  readonly operationError?: never;
}

interface TransientReport extends FailedReportBase {
  readonly reason: "transient";
  readonly retryable: true;
  readonly operationError?: never;
}

interface IncompleteReport extends FailedReportBase {
  readonly reason: "incomplete";
  readonly retryable: true;
  readonly operationError?: string;
}

export type FailedReport = ConflictReport | TransientReport | IncompleteReport;
export type ReconcileReport = CompleteReport | FailedReport;

interface ObservedReleaseState {
  packages: Observation[];
  tags: Observation[];
  githubRelease?: Observation;
}

type PublicationResult =
  | { state: "published"; packages: Observation[] }
  | { state: "failed"; report: FailedReport };

type TagFinalizationResult =
  | { state: "complete"; tags: Observation[]; attempted: boolean }
  | { state: "failed"; report: FailedReport };

function complete(state: ObservedReleaseState): CompleteReport {
  return state.githubRelease
    ? {
        state: "complete",
        packages: state.packages,
        tags: state.tags,
        githubRelease: state.githubRelease,
      }
    : { state: "complete", packages: state.packages, tags: state.tags };
}

function reportFields(state: ObservedReleaseState): FailedReportBase {
  return state.githubRelease
    ? {
        state: "failed",
        packages: state.packages,
        tags: state.tags,
        githubRelease: state.githubRelease,
      }
    : { state: "failed", packages: state.packages, tags: state.tags };
}

function failure(
  reason: FailedReport["reason"],
  state: ObservedReleaseState,
): FailedReport {
  const fields = reportFields(state);
  switch (reason) {
    case "conflict":
      return { ...fields, reason, retryable: false };
    case "transient":
      return { ...fields, reason, retryable: true };
    case "incomplete":
      return { ...fields, reason, retryable: true };
  }
}

function incompleteFailure(
  state: ObservedReleaseState,
  operationError?: string,
): IncompleteReport {
  const report = {
    ...reportFields(state),
    reason: "incomplete" as const,
    retryable: true as const,
  };
  return operationError === undefined ? report : { ...report, operationError };
}

function contains(
  observations: readonly Observation[],
  observationState: ObservationState,
): boolean {
  return observations.some(
    (observation) => observation.state === observationState,
  );
}

function missingPackages(
  plan: ReleasePlan,
  observations: readonly Observation[],
): ReleasePackage[] {
  return plan.packages.filter(
    (_, index) => observations[index]?.state === "missing",
  );
}

function inspectionFailure(
  state: ObservedReleaseState,
): FailedReport | undefined {
  const observations =
    state.githubRelease === undefined
      ? [...state.packages, ...state.tags]
      : [...state.packages, ...state.tags, state.githubRelease];

  if (contains(observations, "conflicting")) return failure("conflict", state);
  if (contains(observations, "transient")) return failure("transient", state);
  if (
    contains(state.packages, "repairable") ||
    contains(state.tags, "repairable")
  ) {
    return failure("conflict", state);
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
  return ports.observeGithubRelease(plan.githubRelease);
}

async function observeDesiredState(
  plan: ReleasePlan,
  ports: ReconcilePorts,
): Promise<ObservedReleaseState> {
  const packages = await observePackages(plan, ports);
  const tags = await observeTags(plan, ports);
  const githubRelease = await observeGithubRelease(plan, ports);
  return githubRelease === undefined
    ? { packages, tags }
    : { packages, tags, githubRelease };
}

async function checkRelease(
  plan: ReleasePlan,
  ports: ReconcilePorts,
  state: ObservedReleaseState,
): Promise<ReconcileReport> {
  if (missingPackages(plan, state.packages).length > 0) {
    await ports.dryRunPackages(plan.packages);
  }

  if (
    contains(state.packages, "missing") ||
    contains(state.tags, "missing") ||
    (state.githubRelease !== undefined &&
      state.githubRelease.state !== "matching")
  ) {
    return failure("incomplete", state);
  }
  return complete(state);
}

async function publishMissingPackages(
  plan: ReleasePlan,
  ports: ReconcilePorts,
  state: ObservedReleaseState,
  attempts: number,
): Promise<PublicationResult> {
  await ports.dryRunPackages(plan.packages);
  const missing = missingPackages(plan, state.packages);
  const maximumAttempts = Math.max(1, attempts);
  let publicationError: string | undefined;
  try {
    await ports.publishPackages(missing);
  } catch (error: unknown) {
    publicationError = errorMessage(error);
  }

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    await ports.wait();
    const packages = await observePackages(plan, ports);
    const observed = { ...state, packages };

    if (contains(packages, "conflicting")) {
      return { state: "failed", report: failure("conflict", observed) };
    }
    if (packages.every((observation) => observation.state === "matching")) {
      return { state: "published", packages };
    }
    if (attempt === maximumAttempts - 1) {
      if (contains(packages, "transient")) {
        return { state: "failed", report: failure("transient", observed) };
      }
      return {
        state: "failed",
        report: incompleteFailure(observed, publicationError),
      };
    }
  }

  throw new Error("publication attempts must include at least one observation");
}

async function finalizeMissingTags(
  plan: ReleasePlan,
  ports: ReconcilePorts,
  state: ObservedReleaseState,
): Promise<TagFinalizationResult> {
  const tags = [...state.tags];
  const missingTagIndexes = plan.packages.flatMap((_, index) =>
    tags[index]?.state === "missing" ? [index] : [],
  );

  for (const index of missingTagIndexes) {
    const item = plan.packages[index];
    if (item === undefined) throw new Error("release plan index is invalid");
    let tagCreationError: Error | undefined;
    try {
      await ports.createTag(item);
    } catch (error: unknown) {
      tagCreationError = asError(error);
    }

    tags[index] = await ports.observeTag(item);
    const observed = { ...state, tags };
    const afterTagFailure = inspectionFailure(observed);
    if (afterTagFailure) {
      return { state: "failed", report: afterTagFailure };
    }
    if (tags[index]?.state === "missing") {
      if (tagCreationError !== undefined) throw tagCreationError;
      return {
        state: "failed",
        report: failure("incomplete", observed),
      };
    }
  }

  return {
    state: "complete",
    tags,
    attempted: missingTagIndexes.length > 0,
  };
}

async function finalizeGithubRelease(
  release: GithubRelease,
  ports: ReconcilePorts,
  state: ObservedReleaseState & { githubRelease: Observation },
): Promise<ReconcileReport> {
  if (
    state.githubRelease.state !== "missing" &&
    state.githubRelease.state !== "repairable"
  ) {
    return complete(state);
  }

  let releaseMutationError: Error | undefined;
  try {
    if (state.githubRelease.state === "missing") {
      await ports.createGithubRelease(release);
    } else {
      await ports.updateGithubRelease(release);
    }
  } catch (error: unknown) {
    releaseMutationError = asError(error);
  }

  const githubRelease = await ports.observeGithubRelease(release);
  const observed = { ...state, githubRelease };
  const afterReleaseFailure = inspectionFailure(observed);
  if (afterReleaseFailure) return afterReleaseFailure;
  if (githubRelease.state !== "matching") {
    if (releaseMutationError !== undefined) throw releaseMutationError;
    return failure("incomplete", observed);
  }
  return complete(observed);
}

async function finalizeRelease(
  plan: ReleasePlan,
  ports: ReconcilePorts,
  initialState: ObservedReleaseState,
  refreshBeforeFinalization: boolean,
): Promise<ReconcileReport> {
  let state = initialState;
  if (refreshBeforeFinalization) {
    const tags = await observeTags(plan, ports);
    const githubRelease = await observeGithubRelease(plan, ports);
    state =
      githubRelease === undefined
        ? { ...state, tags }
        : { ...state, tags, githubRelease };
    const finalizationFailure = inspectionFailure(state);
    if (finalizationFailure) return finalizationFailure;
  }

  if (missingPackages(plan, state.packages).length > 0) {
    return failure("incomplete", state);
  }

  const tagResult = await finalizeMissingTags(plan, ports, state);
  if (tagResult.state === "failed") return tagResult.report;
  state = { ...state, tags: tagResult.tags };

  if (tagResult.attempted) {
    const githubRelease = await observeGithubRelease(plan, ports);
    state = githubRelease === undefined ? state : { ...state, githubRelease };
    const releaseRaceFailure = inspectionFailure(state);
    if (releaseRaceFailure) return releaseRaceFailure;
  }

  if (!plan.githubRelease) return complete(state);
  if (state.githubRelease === undefined) {
    throw new Error("configured GitHub Release was not observed");
  }
  return finalizeGithubRelease(plan.githubRelease, ports, {
    ...state,
    githubRelease: state.githubRelease,
  });
}

export async function reconcile(
  plan: ReleasePlan,
  phase: Phase,
  ports: ReconcilePorts,
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  let state = await observeDesiredState(plan, ports);
  const preflightFailure = inspectionFailure(state);
  if (preflightFailure) return preflightFailure;

  if (phase === "check") return checkRelease(plan, ports, state);

  let attemptedPublication = false;
  if (
    (phase === "publish" || phase === "all") &&
    missingPackages(plan, state.packages).length > 0
  ) {
    attemptedPublication = true;
    const publication = await publishMissingPackages(
      plan,
      ports,
      state,
      options.attempts,
    );
    if (publication.state === "failed") return publication.report;
    state = { ...state, packages: publication.packages };
  }

  if (phase === "publish") return complete(state);
  return finalizeRelease(plan, ports, state, attemptedPublication);
}
