import type {
  AssessmentScope,
  ExecutionNode,
  SecurityAssessment,
} from "./security-domain.ts";

export interface SecurityStore {
  saveAssessmentScope(scope: AssessmentScope): AssessmentScope;
  findAssessmentScope(id: string): AssessmentScope | null;

  saveSecurityAssessment(assessment: SecurityAssessment): SecurityAssessment;
  saveSecurityAssessmentBundle(input: { assessment: SecurityAssessment; scope: AssessmentScope }): SecurityAssessment;
  findSecurityAssessment(id: string): SecurityAssessment | null;
  listSecurityAssessments(projectId: string): SecurityAssessment[];

  saveExecutionNode(node: ExecutionNode): ExecutionNode;
  findExecutionNode(id: string): ExecutionNode | null;
  listExecutionNodes(): ExecutionNode[];
  deleteExecutionNode(id: string): boolean;

  close(): void;
}
