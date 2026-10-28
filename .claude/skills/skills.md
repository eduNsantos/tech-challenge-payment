# Skills — tech-challenge-payment-service

Guia de habilidades e procedimentos para o Claude Code neste repositório de infraestrutura AWS (Terraform) do serviço de pagamento.

> **CONTEXTO:** Este repositório provisiona a infraestrutura AWS do payment-service:
> Lambdas (Node.js), API Gateway v2 (HTTP API), VPC compartilhada com o EKS,
> Secrets Manager, IAM e backend de estado Terraform no S3.
> Região padrão: **us-east-1**. Account ID: **477478162709**.

---

## terraform-workflow

Fluxo padrão para qualquer alteração de infraestrutura.

**Quando usar:** toda vez que for criar, alterar ou destruir recursos AWS via Terraform.

**Passos obrigatórios (nesta ordem):**

1. **Init** — inicializa providers e backend S3:
   ```bash
   terraform init -input=false -reconfigure -lock-timeout=5m
   ```

2. **Validate** — verifica erros de sintaxe antes de planejar:
   ```bash
   terraform validate
   ```

3. **Plan** — mostra o que será criado/alterado/destruído:
   ```bash
   terraform plan -out=tfplan -input=false -lock-timeout=5m
   ```
   > Revisar o output do plan com atenção. Nunca aplicar sem revisar.

4. **Apply** — aplica apenas o plan gerado:
   ```bash
   terraform apply -input=false -lock-timeout=5m tfplan
   ```

5. **Outputs** — exibir endpoints e ARNs provisionados:
   ```bash
   terraform output
   ```

**Backend S3:**
- Bucket: `techchallenge-tfstate-477478162709`
- Key: `payment-service/terraform.tfstate`
- Região: `us-east-1`
- Criptografia: `encrypt = true`, `use_lockfile = true`

**Variáveis de ambiente necessárias no CI:**
```
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
TF_VAR_db_password
TF_VAR_jwt_secret
```

---

## add-lambda

Adiciona uma nova função Lambda ao payment-service.

**Quando usar:** criar um novo handler de pagamento (ex: processar pagamento, webhook Mercado Pago, confirmação de pedido).

**Checklist (nesta ordem):**

- [ ] Criar o código da função em `src/{nome-da-funcao}/index.js` (ou `handler.ts` se TypeScript)
- [ ] Adicionar dependências ao `src/package.json` se necessário
- [ ] Criar arquivo Terraform `{nome}.tf` com os recursos abaixo:

### Template Terraform para nova Lambda

```hcl
# Build / package
resource "null_resource" "{nome}_lambda_deps" {
  triggers = {
    package_lock = filemd5("${path.module}/src/package-lock.json")
  }

  provisioner "local-exec" {
    command     = "cd ${path.module}/src && npm ci --no-fund --no-audit"
    interpreter = ["bash", "-c"]
  }
}

data "archive_file" "{nome}_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/src/{nome-da-funcao}"
  output_path = "${path.module}/build/{nome-da-funcao}.zip"
  depends_on  = [null_resource.{nome}_lambda_deps]
}

# IAM
resource "aws_iam_role" "{nome}_lambda" {
  name               = "payment-{nome}-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "{nome}_vpc_access" {
  role       = aws_iam_role.{nome}_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Lambda Function
resource "aws_lambda_function" "{nome}" {
  function_name    = "payment-{nome}"
  role             = aws_iam_role.{nome}_lambda.arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.{nome}_lambda.output_path
  source_code_hash = data.archive_file.{nome}_lambda.output_base64sha256
  timeout          = 10
  memory_size      = 256

  vpc_config {
    subnet_ids         = [data.aws_subnet.sub_a.id, data.aws_subnet.sub_b.id]
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      SECRET_ID = aws_secretsmanager_secret.{nome}_lambda.name
      DB_HOST   = data.aws_db_instance.main.address
      DB_PORT   = tostring(data.aws_db_instance.main.port)
      DB_NAME   = var.db_name
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.{nome}_vpc_access,
  ]
}
```

**Recursos de rede (reutilizar do `data.tf` ou `network.tf`):**
- Subnets: `data.aws_subnet.sub_a`, `data.aws_subnet.sub_b`
- Security group: `aws_security_group.lambda`

**Após criar a Lambda:**
- [ ] Adicionar rota no API Gateway (ver skill `add-apigateway-route`)
- [ ] Adicionar secret se necessário (ver skill `add-secret`)
- [ ] Atualizar `output.tf` com o invoke_arn ou endpoint
- [ ] Rodar o `terraform-workflow` completo

---

## add-apigateway-route

Adiciona uma nova rota ao API Gateway v2 (HTTP API) do payment-service.

**Quando usar:** expor um novo endpoint HTTP da Lambda via API Gateway.

**Template Terraform:**

```hcl
resource "aws_apigatewayv2_integration" "{nome}" {
  api_id                 = aws_apigatewayv2_api.payment.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.{nome}.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "{nome}_{metodo}" {
  api_id    = aws_apigatewayv2_api.payment.id
  route_key = "{METODO} /{path}"          # ex: "POST /payment", "GET /payment/{id}"
  target    = "integrations/${aws_apigatewayv2_integration.{nome}.id}"
}

resource "aws_lambda_permission" "apigateway_{nome}" {
  statement_id  = "AllowAPIGatewayInvoke{Nome}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.{nome}.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.payment.execution_arn}/*/*"
}
```

**Padrões de `route_key`:**
| Operação                | route_key                  |
|-------------------------|----------------------------|
| Processar pagamento      | `POST /payment`            |
| Consultar status         | `GET /payment/{id}`        |
| Webhook externo          | `POST /webhook/mercadopago`|
| Cancelar pagamento       | `DELETE /payment/{id}`     |

**Após adicionar a rota:**
- [ ] Verificar `aws_apigatewayv2_stage` com `auto_deploy = true` (não requer novo deploy manual)
- [ ] Capturar o endpoint no `output.tf`
- [ ] Testar com `curl` o endpoint do stage após o `terraform apply`

---

## add-secret

Cria ou atualiza um secret no AWS Secrets Manager via Terraform.

**Quando usar:** armazenar credenciais sensíveis (chave de API do gateway de pagamento, senhas, tokens).

**Template Terraform:**

```hcl
resource "aws_secretsmanager_secret" "{nome}" {
  name                    = "payment/{nome}"
  recovery_window_in_days = 0   # 0 = delete imediato (útil em dev/staging)
}

resource "aws_secretsmanager_secret_version" "{nome}" {
  secret_id = aws_secretsmanager_secret.{nome}.id
  secret_string = jsonencode({
    CHAVE_1 = var.{nome}_chave_1
    CHAVE_2 = var.{nome}_chave_2
  })
}
```

**Adicionar variável correspondente em `variables.tf`:**
```hcl
variable "{nome}_chave_1" {
  type      = string
  sensitive = true
}
```

**Dar acesso à Lambda no IAM (em `lambda.tf` ou no arquivo da Lambda):**
```hcl
data "aws_iam_policy_document" "{nome}_secrets_access" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.{nome}.arn]
  }
}

resource "aws_iam_role_policy" "{nome}_secrets_access" {
  name   = "payment-{nome}-secrets-access"
  role   = aws_iam_role.{nome}_lambda.id
  policy = data.aws_iam_policy_document.{nome}_secrets_access.json
}
```

**Injetar o nome do secret na Lambda via environment:**
```hcl
environment {
  variables = {
    SECRET_ID = aws_secretsmanager_secret.{nome}.name
  }
}
```

---

## aws-ops

Operações comuns de diagnóstico e inspeção dos recursos AWS do payment-service.

**Quando usar:** depurar erros, verificar estado de recursos, consultar logs.

### Credenciais e contexto

```bash
# Verificar identidade AWS ativa
aws sts get-caller-identity

# Listar Lambdas do payment-service
aws lambda list-functions \
  --query 'Functions[?starts_with(FunctionName, `payment`)].{Nome:FunctionName,Runtime:Runtime,Memoria:MemorySize}' \
  --output table

# Verificar estado do Terraform
terraform show
terraform state list
```

### Logs das Lambdas

```bash
# Últimas invocações de uma Lambda (substituir {nome})
aws logs tail /aws/lambda/payment-{nome} --follow

# Buscar erros nos logs
aws logs filter-log-events \
  --log-group-name /aws/lambda/payment-{nome} \
  --filter-pattern "ERROR"

# Últimas 100 linhas
aws logs get-log-events \
  --log-group-name /aws/lambda/payment-{nome} \
  --log-stream-name $(aws logs describe-log-streams \
      --log-group-name /aws/lambda/payment-{nome} \
      --order-by LastEventTime --descending \
      --max-items 1 \
      --query 'logStreams[0].logStreamName' --output text) \
  --limit 100
```

### API Gateway

```bash
# Listar APIs do payment-service
aws apigatewayv2 get-apis \
  --query 'Items[?contains(Name, `payment`)].{Id:ApiId,Nome:Name,Endpoint:ApiEndpoint}' \
  --output table

# Listar rotas de uma API específica
aws apigatewayv2 get-routes --api-id {API_ID}
```

### Invocar Lambda manualmente

```bash
# Invocar e ver resposta
aws lambda invoke \
  --function-name payment-{nome} \
  --payload '{"body": "{\"amount\": 100}"}' \
  --cli-binary-format raw-in-base64-out \
  response.json && cat response.json
```

### Secrets Manager

```bash
# Listar secrets do payment-service
aws secretsmanager list-secrets \
  --query 'SecretList[?starts_with(Name, `payment`)].Name' \
  --output table

# Ver valor de um secret (cuidado em produção)
aws secretsmanager get-secret-value \
  --secret-id payment/{nome} \
  --query SecretString \
  --output text | jq .
```

---

## terraform-destroy

Destrói recursos Terraform de forma segura.

**Quando usar:** remover infraestrutura de ambiente de teste ou recurso específico que não é mais necessário.

> **ATENÇÃO:** Nunca rodar `terraform destroy` sem revisar o plan de destruição antes.
> Recursos como Secrets Manager com `recovery_window_in_days = 0` são **imediatamente deletados**.

### Destruir recurso específico

```bash
# Ver o que seria destruído
terraform plan -destroy -target=aws_lambda_function.{nome}

# Destruir apenas aquele recurso
terraform destroy -target=aws_lambda_function.{nome} -auto-approve
```

### Destruir tudo (ambiente completo)

```bash
# REVISÃO OBRIGATÓRIA antes de confirmar
terraform plan -destroy

# Só executar após revisão cuidadosa
terraform destroy -auto-approve
```

### Remover recurso do state sem destruir o recurso real na AWS

```bash
# Útil quando o recurso foi criado fora do Terraform ou vai ser importado
terraform state rm aws_lambda_function.{nome}
```

---

## deploy

Fluxo completo de deploy do payment-service via GitHub Actions.

**Quando usar:** entender ou reproduzir manualmente o pipeline de CI/CD.

### Pipeline GitHub Actions (`.github/workflows/deploy.yml`)

```
push → main
  └── terraform (init + apply)
        └── deploy-lambda (empacota e faz upload das Lambdas)
```

**Secrets necessários no repositório GitHub:**
| Secret                    | Descrição                              |
|---------------------------|----------------------------------------|
| `AWS_ACCESS_KEY_ID`       | Chave de acesso AWS                    |
| `AWS_SECRET_ACCESS_KEY`   | Chave secreta AWS                      |
| `DB_PASSWORD`             | Senha do banco de dados                |
| `JWT_SECRET`              | Chave JWT (se aplicável)               |
| `MERCADOPAGO_ACCESS_TOKEN`| Token do gateway de pagamento          |

### Disparar deploy manual

```bash
# Via GitHub CLI — deploy da branch main
gh workflow run deploy.yml --ref main

# Com parâmetro de tag de imagem (se aplicável)
gh workflow run deploy.yml --ref main -f image_tag=v1.2.3

# Verificar status do workflow
gh run list --workflow=deploy.yml --limit 5

# Ver logs do último run
gh run view --log
```

### Estrutura esperada do repositório após scaffold

```
tech-challenge-payment-service/
├── src/
│   ├── package.json
│   ├── package-lock.json
│   └── {nome-da-funcao}/
│       └── index.js
├── build/                    # gerado pelo Terraform (gitignore)
├── providers.tf
├── variables.tf
├── output.tf
├── network.tf                # data sources da VPC/subnets do EKS
├── security-groups.tf
├── lambda.tf
├── apigateway.tf
├── secrets.tf
├── .terraform.lock.hcl
├── .github/
│   └── workflows/
│       └── deploy.yml
└── .gitignore
```

---

## scaffold-payment-service

Cria o scaffold completo do repositório payment-service do zero.

**Quando usar:** o repositório está vazio e precisa ser inicializado com toda a estrutura Terraform + Lambda.

**Checklist completo:**

- [ ] Criar `providers.tf` com backend S3 (`key = "payment-service/terraform.tfstate"`)
- [ ] Criar `variables.tf` com variáveis padrão (region, db_name, db_user, db_password)
- [ ] Criar `network.tf` com data sources para VPC, subnets e RDS do projeto EKS principal
- [ ] Criar `security-groups.tf` com security group para as Lambdas
- [ ] Criar `apigateway.tf` com o `aws_apigatewayv2_api` principal e o stage `$default`
- [ ] Criar `lambda.tf` com a primeira Lambda (ex: `payment-process`)
- [ ] Criar `secrets.tf` com o secret do gateway de pagamento
- [ ] Criar `output.tf` com o endpoint da API
- [ ] Criar `src/package.json` e `src/{nome}/index.js`
- [ ] Criar `.github/workflows/deploy.yml`
- [ ] Criar `.gitignore` (ignorar `build/`, `.terraform/`, `*.tfstate`, `*.tfplan`)
- [ ] Rodar `terraform init` para gerar `.terraform.lock.hcl`
- [ ] Commit inicial

**Data sources compartilhados (referências ao stack do EKS em `network.tf`):**
```hcl
data "aws_vpc" "main" {
  filter {
    name   = "tag:Name"
    values = ["main"]
  }
}

data "aws_subnet" "sub_a" {
  filter {
    name   = "tag:Name"
    values = ["sub_a"]
  }
}

data "aws_subnet" "sub_b" {
  filter {
    name   = "tag:Name"
    values = ["sub_b"]
  }
}

data "aws_db_instance" "main" {
  db_instance_identifier = "main"
}
```
