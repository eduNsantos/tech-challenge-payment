resource "null_resource" "lambda_deps" {
  triggers = {
    package_lock = filemd5("${path.module}/../src/package-lock.json")
    package_json = filemd5("${path.module}/../src/package.json")
  }

  provisioner "local-exec" {
    command     = "cd ${path.module}/../src && npm ci --no-fund --no-audit"
    interpreter = ["bash", "-c"]
  }
}

data "archive_file" "payment_lambdas" {
  type        = "zip"
  source_dir  = "${path.module}/../src"
  output_path = "${path.module}/../build/payment-lambdas.zip"
  excludes    = ["test", "*.test.js"]

  depends_on = [null_resource.lambda_deps]
}
