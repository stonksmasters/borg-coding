import type {
  AssessmentScope,
  ExecutionNode,
  SecurityAssessment,
  SecurityEvidenceRecord,
  SecurityExecutionRecord,
  SecurityAsset,
  SecurityNetworkService,
  SecurityObservation,
  SecurityRelationship,
  SecurityInvestigationPlan,
  IdentityProfile,
  IdentityIdentifier,
  SecurityJob,
} from "./security-domain.ts";

export interface SecurityStore {
  saveIdentityProfile(profile: IdentityProfile): IdentityProfile;
  findIdentityProfile(id: string): IdentityProfile | null;
  listIdentityProfiles(projectId: string, includeArchived?: boolean): IdentityProfile[];
  saveIdentityIdentifier(identifier: IdentityIdentifier): IdentityIdentifier;
  findIdentityIdentifier(id: string): IdentityIdentifier | null;
  listIdentityIdentifiers(profileId: string): IdentityIdentifier[];
  saveSecurityJob(job: SecurityJob): SecurityJob;
  findSecurityJob(id: string): SecurityJob | null;
  listSecurityJobs(profileId?: string): SecurityJob[];

  saveAssessmentScope(scope: AssessmentScope): AssessmentScope;
  findAssessmentScope(id: string): AssessmentScope | null;

  saveSecurityAssessment(assessment: SecurityAssessment): SecurityAssessment;
  saveSecurityAssessmentBundle(input: { assessment: SecurityAssessment; scope: AssessmentScope }): SecurityAssessment;
  findSecurityAssessment(id: string): SecurityAssessment | null;
  listSecurityAssessments(projectId: string): SecurityAssessment[];

  saveSecurityInvestigationPlan(plan: SecurityInvestigationPlan): SecurityInvestigationPlan;
  findSecurityInvestigationPlan(id: string): SecurityInvestigationPlan | null;
  listSecurityInvestigationPlans(assessmentId: string): SecurityInvestigationPlan[];

  saveExecutionNode(node: ExecutionNode): ExecutionNode;
  findExecutionNode(id: string): ExecutionNode | null;
  listExecutionNodes(): ExecutionNode[];
  deleteExecutionNode(id: string): boolean;

  saveSecurityExecution(execution: SecurityExecutionRecord): SecurityExecutionRecord;
  findSecurityExecution(id: string): SecurityExecutionRecord | null;
  listSecurityExecutions(assessmentId: string): SecurityExecutionRecord[];
  deleteSecurityExecution(id: string): boolean;

  saveSecurityEvidence(evidence: SecurityEvidenceRecord): SecurityEvidenceRecord;
  listSecurityEvidence(executionId: string): SecurityEvidenceRecord[];

  saveSecurityKnowledge(input: {
    assets: SecurityAsset[];
    services: SecurityNetworkService[];
    observations: SecurityObservation[];
    relationships: SecurityRelationship[];
  }): void;
  listSecurityAssets(assessmentId: string): SecurityAsset[];
  findSecurityAsset(id: string): SecurityAsset | null;
  listSecurityServices(assessmentId: string, assetId?: string): SecurityNetworkService[];
  listSecurityObservations(assessmentId: string, assetId?: string): SecurityObservation[];
  listSecurityRelationships(assessmentId: string, assetId?: string): SecurityRelationship[];

  close(): void;
}
