data "aws_caller_identity" "current" {}

# ─── URL do application (fallback de notification_url) ──────────────────────
# Se var.app_notification_url estiver vazia, descobre o ELB que o Kubernetes criou
# para o Service do app (tag kubernetes.io/service-name). Sem ELB (app ainda não
# implantado), o fallback fica vazio e só vale o notification_url da mensagem.

data "aws_resourcegroupstaggingapi_resources" "app_lb" {
  count = var.app_notification_url == "" ? 1 : 0

  resource_type_filters = ["elasticloadbalancing:loadbalancer"]

  tag_filter {
    key    = "kubernetes.io/service-name"
    values = [var.app_k8s_service]
  }
}

locals {
  app_lb_arns = var.app_notification_url == "" ? [
    for r in data.aws_resourcegroupstaggingapi_resources.app_lb[0].resource_tag_mapping_list : r.resource_arn
  ] : []
}

# ELB clássico: arn:aws:elasticloadbalancing:<região>:<conta>:loadbalancer/<nome>
data "aws_elb" "app" {
  count = length(local.app_lb_arns) > 0 ? 1 : 0

  name = element(split("/", local.app_lb_arns[0]), 1)
}

locals {
  app_notification_url = (
    var.app_notification_url != "" ? var.app_notification_url :
    length(data.aws_elb.app) > 0 ? "http://${data.aws_elb.app[0].dns_name}:${var.app_port}/api/payment/notification" :
    ""
  )
}
