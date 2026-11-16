resource "null_resource" "lambda_deps" {
  triggers = {
    package_lock = filemd5("${path.module}/../src/package-lock.json")
    package_json = filemd5("${path.module}/../src/package.json")
  }

  provisioner "local-exec" {
    # Só dependências de produção no pacote (jest e cucumber ficam fora do zip)
    command     = "cd ${path.module}/../src && npm ci --omit=dev --no-fund --no-audit"
    interpreter = ["bash", "-c"]
  }
}

data "archive_file" "payment_lambdas" {
  type        = "zip"
  source_dir  = "${path.module}/../src"
  output_path = "${path.module}/../build/payment-lambdas.zip"
  excludes    = ["test", "*.test.js", "features", "cucumber.js", "coverage", ".c8rc.json"]

  depends_on = [null_resource.lambda_deps]
}
