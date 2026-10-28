# AWS Academy não permite criar IAM roles (iam:CreateRole é bloqueado pela SCP).
# Usa a LabRole pré-existente para todas as Lambdas e Step Functions.
data "aws_iam_role" "lab_role" {
  name = "LabRole"
}
