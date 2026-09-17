import { asError, errorMessage } from "./errors.js";
import type {
  GithubRelease,
  ReleasePackage,
  ReleasePlan,
  ReleasePolicy,
} from "./release-plan.js";

export type {
  GithubRelease,
  ReleasePackage,
  ReleasePlan,
  ReleasePolicy,
} from "./release-plan.js";

export type Phase = "observe" | "check" | "publish" | "finalize" | "all";

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
  policy?: ReleasePolicy;
}

export type ComponentStatus = "complete" | "incomplete" | "conflict";

export interface ReleaseStatus {
  readonly crates: ComponentStatus;
  readonly tags: ComponentStatus;
  readonly githubRelease?: ComponentStatus;
  readonly pendingCrates: readonly string[];
}

interface ReportBase {
  readonly status: ReleaseStatus;
  readonly policy: ReleasePolicy;
  readonly packages: readonly Observation[];
  readonly tags: readonly Observation[];
  readonly githubRelease?: Observation;
}

export interface CompleteReport extends ReportBase {
  readonly state: "complete";
}

export interface IncompleteReport extends ReportBase {
  readonly state: "incomplete";
  readonly retryable: true;
  readonly operationError?: string;
}

interface FailedReportBase extends ReportBase {
  readonly state: "failed";
  readonly operationError?: never;
}

interface ConflictReport extends FailedReportBase {
  readonly reason: "conflict";
  readonly retryable: false;
}

interface TransientReport extends FailedReportBase {
  readonly reason: "transient";
  readonly retryable: true;
}

export type FailedReport = ConflictReport | TransientReport;
export type ReconcileReport = CompleteReport | IncompleteReport | FailedReport;

interface ObservedReleaseState {
  packages: readonly Observation[];
  tags: readonly Observation[];
  githubRelease?: Observation;
}

interface FinalizationInput {
  readonly refreshObservations: boolean;
  readonly publicationError?: string;
}

const DEFAULT_POLICY: ReleasePolicy = {
  finalize: { allowMissingCrates: false },
};

type PublicationResult =
  | { state: "published"; packages: readonly Observation[] }
  | {
      state: "pending";
      packages: readonly Observation[];
      operationError: string | undefined;
    }
  | { state: "failed"; report: FailedReport };

type TagFinalizationResult =
  | { state: "complete"; tags: readonly Observation[]; attempted: boolean }
  | { state: "failed"; report: FailedReport };

type ReleaseFinalizationResult =
  | { state: "complete"; githubRelease: Observation }
  | { state: "failed"; report: FailedReport };

function componentStatus(
  observations: readonly Observation[],
): ComponentStatus {
  if (contains(observations, "conflicting")) return "conflict";
  return observations.every((observation) => observation.state === "matching")
    ? "complete"
    : "incomplete";
}

function allObservations(state: ObservedReleaseState): readonly Observation[] {
  return state.githubRelease === undefined
    ? [...state.packages, ...state.tags]
    : [...state.packages, ...state.tags, state.githubRelease];
}

function releaseStatus(state: ObservedReleaseState): ReleaseStatus {
  const crates = componentStatus(state.packages);
  const tags = componentStatus(state.tags);
  const pendingCrates = state.packages
    .filter((observation) => observation.state === "missing")
    .map((observation) => observation.subject);
  return state.githubRelease === undefined
    ? { crates, tags, pendingCrates }
    : {
        crates,
        tags,
        githubRelease: componentStatus([state.githubRelease]),
        pendingCrates,
      };
}

function reportBase(
  state: ObservedReleaseState,
  policy: ReleasePolicy,
): ReportBase {
  const fields = {
    status: releaseStatus(state),
    policy,
    packages: state.packages,
    tags: state.tags,
  };
  return state.githubRelease
    ? { ...fields, githubRelease: state.githubRelease }
    : fields;
}

function complete(
  state: ObservedReleaseState,
  policy: ReleasePolicy,
): CompleteReport {
  return { state: "complete", ...reportBase(state, policy) };
}

function incomplete(
  state: ObservedReleaseState,
  policy: ReleasePolicy,
  operationError?: string,
): IncompleteReport {
  const report = {
    state: "incomplete" as const,
    retryable: true as const,
    ...reportBase(state, policy),
  };
  return operationError === undefined ? report : { ...report, operationError };
}

function observed(
  state: ObservedReleaseState,
  policy: ReleasePolicy,
): ReconcileReport {
  return allObservations(state).every(
    (observation) => observation.state === "matching",
  )
    ? complete(state, policy)
    : incomplete(state, policy);
}

function settle(
  state: ObservedReleaseState,
  policy: ReleasePolicy,
  operationError?: string,
): ReconcileReport {
  return state.packages.every((observation) => observation.state === "matching")
    ? complete(state, policy)
    : incomplete(state, policy, operationError);
}

function failure(
  reason: FailedReport["reason"],
  state: ObservedReleaseState,
  policy: ReleasePolicy,
): FailedReport {
  const fields = { state: "failed" as const, ...reportBase(state, policy) };
  return reason === "conflict"
    ? { ...fields, reason, retryable: false }
    : { ...fields, reason, retryable: true };
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
  policy: ReleasePolicy,
): FailedReport | undefined {
  const observations = allObservations(state);

  if (contains(observations, "conflicting")) {
    return failure("conflict", state, policy);
  }
  if (contains(observations, "transient")) {
    return failure("transient", state, policy);
  }
  if (
    contains(state.packages, "repairable") ||
    contains(state.tags, "repairable")
  ) {
    return failure("conflict", state, policy);
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

async function publishMissingPackages(
  plan: ReleasePlan,
  ports: ReconcilePorts,
  state: ObservedReleaseState,
  policy: ReleasePolicy,
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
      return { state: "failed", report: failure("conflict", observed, policy) };
    }
    if (packages.every((observation) => observation.state === "matching")) {
      return { state: "published", packages };
    }
    if (attempt === maximumAttempts - 1) {
      if (contains(packages, "transient")) {
        return {
          state: "failed",
          report: failure("transient", observed, policy),
        };
      }
      return { state: "pending", packages, operationError: publicationError };
    }
  }

  throw new Error("publication attempts must include at least one observation");
}

async function finalizeMissingTags(
  plan: ReleasePlan,
  ports: ReconcilePorts,
  state: ObservedReleaseState,
  policy: ReleasePolicy,
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
    const afterTagFailure = inspectionFailure(observed, policy);
    if (afterTagFailure) {
      return { state: "failed", report: afterTagFailure };
    }
    if (tags[index]?.state === "missing") {
      if (tagCreationError !== undefined) throw tagCreationError;
      return {
        state: "failed",
        report: failure("transient", observed, policy),
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
  policy: ReleasePolicy,
): Promise<ReleaseFinalizationResult> {
  if (
    state.githubRelease.state !== "missing" &&
    state.githubRelease.state !== "repairable"
  ) {
    return { state: "complete", githubRelease: state.githubRelease };
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
  const afterReleaseFailure = inspectionFailure(observed, policy);
  if (afterReleaseFailure) {
    return { state: "failed", report: afterReleaseFailure };
  }
  if (githubRelease.state !== "matching") {
    if (releaseMutationError !== undefined) throw releaseMutationError;
    return {
      state: "failed",
      report: failure("transient", observed, policy),
    };
  }
  return { state: "complete", githubRelease };
}

async function finalizeRelease(
  plan: ReleasePlan,
  ports: ReconcilePorts,
  initialState: ObservedReleaseState,
  policy: ReleasePolicy,
  input: FinalizationInput,
): Promise<ReconcileReport> {
  let state = initialState;
  if (input.refreshObservations) {
    const tags = await observeTags(plan, ports);
    const githubRelease = await observeGithubRelease(plan, ports);
    state =
      githubRelease === undefined
        ? { ...state, tags }
        : { ...state, tags, githubRelease };
    const finalizationFailure = inspectionFailure(state, policy);
    if (finalizationFailure) return finalizationFailure;
  }

  if (
    !policy.finalize.allowMissingCrates &&
    missingPackages(plan, state.packages).length > 0
  ) {
    return incomplete(state, policy);
  }

  const tagResult = await finalizeMissingTags(plan, ports, state, policy);
  if (tagResult.state === "failed") return tagResult.report;
  state = { ...state, tags: tagResult.tags };

  if (tagResult.attempted) {
    const githubRelease = await observeGithubRelease(plan, ports);
    state = githubRelease === undefined ? state : { ...state, githubRelease };
    const releaseRaceFailure = inspectionFailure(state, policy);
    if (releaseRaceFailure) return releaseRaceFailure;
  }

  if (!plan.githubRelease) return settle(state, policy, input.publicationError);
  if (state.githubRelease === undefined) {
    throw new Error("configured GitHub Release was not observed");
  }
  const releaseResult = await finalizeGithubRelease(
    plan.githubRelease,
    ports,
    { ...state, githubRelease: state.githubRelease },
    policy,
  );
  if (releaseResult.state === "failed") return releaseResult.report;
  return settle(
    { ...state, githubRelease: releaseResult.githubRelease },
    policy,
    input.publicationError,
  );
}

export async function reconcile(
  plan: ReleasePlan,
  phase: Phase,
  ports: ReconcilePorts,
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  const policy = options.policy ?? DEFAULT_POLICY;
  let state = await observeDesiredState(plan, ports);
  if (phase === "observe") return observed(state, policy);

  const preflightFailure = inspectionFailure(state, policy);
  if (preflightFailure) return preflightFailure;

  if (phase === "check") {
    await ports.dryRunPackages(plan.packages);
    return observed(state, policy);
  }

  let attemptedPublication = false;
  let publicationError: string | undefined;
  if (
    (phase === "publish" || phase === "all") &&
    missingPackages(plan, state.packages).length > 0
  ) {
    attemptedPublication = true;
    const publication = await publishMissingPackages(
      plan,
      ports,
      state,
      policy,
      options.attempts,
    );
    if (publication.state === "failed") return publication.report;
    state = { ...state, packages: publication.packages };
    if (publication.state === "pending") {
      if (phase === "publish" || !policy.finalize.allowMissingCrates) {
        return incomplete(state, policy, publication.operationError);
      }
      publicationError = publication.operationError;
    }
  } else if (phase === "publish" || phase === "all") {
    await ports.dryRunPackages(plan.packages);
  }

  if (phase === "publish") return complete(state, policy);
  return finalizeRelease(plan, ports, state, policy, {
    refreshObservations: attemptedPublication,
    ...(publicationError === undefined ? {} : { publicationError }),
  });
}
