import type { Role } from './members.js';

/**
 * The role matrix — OSADE-MOSS §M.6.2, §M.6.6.
 *
 * **Every procedure declares a role, here, in one table.** Not as a decorator on each
 * procedure, because the question a reviewer needs to answer is "what can a viewer do?", and
 * that is only answerable if the answer is in one place. `role-matrix.test.ts` iterates the
 * router and fails on any procedure missing from this map — a new procedure is denied by
 * omission rather than allowed by it.
 *
 * **INVARIANT M3: no procedure that executes arbitrary commands is reachable by a non-owner.**
 * The lane shell is a real shell on the host (ARCH §2.4); a confirmed verification plan is
 * arbitrary code that runs on the next verification; `runHeadless` spawns an agent CLI as a
 * process here. Giving any of those to a teammate is giving them code execution on someone
 * else's machine, and no amount of trust between colleagues changes what the daemon is handing
 * out. They are `owner`, and the matrix says so explicitly rather than by accident.
 */

/** `null` means the procedure needs no session at all — the join path itself. */
export type RequiredRole = Role | null;

export const ROLE_MATRIX: Readonly<Record<string, RequiredRole>> = {
  // ── unauthenticated: the door ───────────────────────────────────────────────
  //
  // `health` so a client can tell the daemon is up before it has a token, and `authExchange`
  // because it *is* the authentication. Anything else here would need an argument.
  health: null,
  authExchange: null,

  // ── viewer: see everything, change nothing ──────────────────────────────────
  authLogout: 'viewer',
  taskList: 'viewer',
  taskGet: 'viewer',
  taskTranscript: 'viewer',
  taskFsList: 'viewer',
  taskFsRead: 'viewer',
  taskChangesList: 'viewer',
  taskChangesDiff: 'viewer',
  repoStatus: 'viewer',
  repoBranchList: 'viewer',
  repoBranchHolders: 'viewer',
  repoRulesGet: 'viewer',
  agentCatalogList: 'viewer',
  verifyPlanGet: 'viewer',
  verifyRunLog: 'viewer',
  issueList: 'viewer',
  prPlan: 'viewer',
  mineStatus: 'viewer',
  conventionImpact: 'viewer',
  conventionList: 'viewer',
  retrievalStats: 'viewer',
  contextPackGet: 'viewer',
  contextPackLatest: 'viewer',
  migrationList: 'viewer',
  migrationView: 'viewer',
  migrationMetrics: 'viewer',
  migrationMisses: 'viewer',
  gateClauses: 'viewer',
  attestationGet: 'viewer',
  attestationVerify: 'viewer',
  prSignals: 'viewer',
  catchUp: 'viewer',
  askHistory: 'viewer',
  // A viewer has to be able to say "I am looking at this", or presence would only ever show
  // the people who can change things — which is the opposite of what it is for.
  presenceBeat: 'viewer',

  // ── maintainer: drive the work and decide the gates ─────────────────────────
  taskCreate: 'maintainer',
  taskLaunch: 'maintainer',
  taskSend: 'maintainer',
  taskDropImages: 'maintainer',
  taskArchive: 'maintainer',
  taskRetitle: 'maintainer',
  taskBranchOut: 'maintainer',
  taskSwitchBranch: 'maintainer',
  taskMoveBranch: 'maintainer',
  taskFsWrite: 'maintainer',
  taskClaim: 'maintainer',
  taskRelease: 'maintainer',
  orchestratorOpen: 'maintainer',
  repoOpen: 'maintainer',
  repoRulesSave: 'maintainer',
  repoSetDefaultAgent: 'maintainer',
  verifyPlanDerive: 'maintainer',
  verifyRun: 'maintainer',
  gateDecide: 'maintainer',
  gateEditAndApprove: 'maintainer',
  gateClauseAck: 'maintainer',
  issueImport: 'maintainer',
  scmRefresh: 'maintainer',
  prOpenRequest: 'maintainer',
  issueCommentRequest: 'maintainer',
  mineRepo: 'maintainer',
  conventionConfirm: 'maintainer',
  conventionReject: 'maintainer',
  policyReload: 'maintainer',
  // §M.8.4 — a read-only projection, but it is the compliance record of who approved what.
  auditExport: 'maintainer',
  migrationCreate: 'maintainer',
  migrationExtract: 'maintainer',
  migrationAddChange: 'maintainer',
  migrationChangesConfirm: 'maintainer',
  migrationTargetsSet: 'maintainer',
  migrationChunk: 'maintainer',
  migrationDiscover: 'maintainer',
  migrationLaunchWave: 'maintainer',
  migrationMissesExport: 'maintainer',

  // ── owner: anything that runs code on this machine, or changes who is here ──
  //
  // M3. Not "advanced" features — the ones where the daemon would be handing a remote person
  // a shell on the host, or the credentials to reach it.
  taskShellOpen: 'owner',
  taskShellRead: 'owner',
  taskShellWrite: 'owner',
  taskShellResize: 'owner',
  taskShellClose: 'owner',
  // §M.6.6 names verification-plan edits explicitly: an edited verify command is arbitrary
  // code that runs on the host at the next verification.
  verifyPlanConfirm: 'owner',
  // Spawns an agent CLI as a process on this machine.
  runHeadless: 'owner',
  indexRebuild: 'owner',
  // Reveals the join code and certificate fingerprint — the credentials for reaching this
  // daemon from elsewhere.
  shareInfo: 'owner',
  memberList: 'owner',
  memberInvite: 'owner',
  memberRemove: 'owner',
  memberSetRole: 'owner',
};

/**
 * §M.6.6 — the procedures that hand out code execution on the host.
 *
 * Listed separately as well as in the matrix so the role-matrix test can assert the *reason*
 * rather than a value: if one of these is ever loosened, the failure says what is being given
 * away rather than reporting a changed string.
 */
export const EXECUTES_ARBITRARY_CODE: readonly string[] = [
  'taskShellOpen',
  'taskShellRead',
  'taskShellWrite',
  'taskShellResize',
  'taskShellClose',
  'verifyPlanConfirm',
  'runHeadless',
];

export function requiredRole(procedure: string): RequiredRole | undefined {
  return Object.prototype.hasOwnProperty.call(ROLE_MATRIX, procedure)
    ? ROLE_MATRIX[procedure]
    : undefined;
}
